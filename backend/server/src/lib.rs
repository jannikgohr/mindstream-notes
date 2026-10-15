//! Mindstream's sync server.
//!
//! One process serves account, storage and sharing routes over HTTP. It
//! speaks the protocol of the Etebase client library the app ships, so
//! everything a client stores here is ciphertext the server cannot read. What
//! the server adds is order and access control: which change came first, and
//! who may see or make it.

pub mod admin;
mod admin_api;
mod auth;
mod blob;
mod chunks;
mod collections;
pub mod config;
mod edge;
mod error;
mod events;
mod feed;
mod hub;
mod join;
mod keys;
pub mod limits;
mod links;
mod rooms;
mod security;
mod sharing;
// The account reset route is compiled out of release builds entirely, so no
// production artifact can serve it whatever its configuration says. Debug
// builds (developer machines, the client library's conformance run) keep it
// behind the TEST_RESET setting.
#[cfg(debug_assertions)]
mod test_reset;
#[cfg(test)]
mod testing;
pub mod totp;
mod vault;
mod wire;

use std::ops::Deref;
use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::http::{header, HeaderValue};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::Serialize;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

use blob::BlobStore;
pub use config::Config;
use keys::Keys;

pub struct Inner {
    pub(crate) pool: PgPool,
    pub(crate) blobs: BlobStore,
    pub(crate) keys: Keys,
    pub(crate) vault: vault::Vault,
    pub(crate) auth_limiter: edge::RateLimiter,
    /// What caps open connections, and what caps open sockets.
    pub(crate) connections: Arc<edge::Gate>,
    pub(crate) sockets: Arc<edge::Gate>,
    pub(crate) code_limiter: security::CodeLimiter,
    /// Wrong passwords per account, same throttle shape as the codes above
    /// but looser: people mistype passwords more often than codes.
    pub(crate) password_limiter: security::CodeLimiter,
    pub(crate) hub: hub::Hub,
    pub(crate) config: Config,
}

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

impl Deref for AppState {
    type Target = Inner;

    fn deref(&self) -> &Inner {
        &self.0
    }
}

#[derive(Debug)]
pub enum StartError {
    Database(sqlx::Error),
    Migration(sqlx::migrate::MigrateError),
    Blobs(std::io::Error),
    SecretKey(std::io::Error),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::Database(err) => write!(f, "database: {err}"),
            StartError::Migration(err) => write!(f, "migration: {err}"),
            StartError::Blobs(err) => write!(f, "blob directory: {err}"),
            StartError::SecretKey(err) => write!(f, "secret key: {err}"),
        }
    }
}

impl std::error::Error for StartError {}

impl AppState {
    /// Connect to the database, bring its schema up to date and load the
    /// server's secret.
    pub async fn connect(config: Config) -> Result<Self, StartError> {
        let pool = PgPoolOptions::new()
            .max_connections(config.database_connections)
            .connect(&config.database_url)
            .await
            .map_err(StartError::Database)?;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .map_err(StartError::Migration)?;
        let keys = Keys::load(&pool).await.map_err(StartError::Database)?;
        let blobs = BlobStore::open(&config.blob_dir)
            .await
            .map_err(StartError::Blobs)?;
        let vault = vault::Vault::load(config.secret_key.as_deref(), &config.secret_key_file())
            .await
            .map_err(StartError::SecretKey)?;
        let auth_limiter =
            edge::RateLimiter::new(config.auth_rate_per_minute, config.auth_rate_burst);
        let files = edge::raise_open_file_limit();
        let total =
            edge::connection_room(config.max_connections, files, config.database_connections);
        if config.max_connections > 0 && total < config.max_connections {
            tracing::warn!(
                "the process may open {} files, which leaves room for {total} connections, \
                 not the {} configured; raise its limit on open files to allow them",
                files.unwrap_or_default(),
                config.max_connections
            );
        }
        let gate = || edge::Gate::new(config.max_connections_per_address, total);
        let state = Self(Arc::new(Inner {
            pool,
            blobs,
            keys,
            vault,
            auth_limiter,
            connections: gate(),
            sockets: gate(),
            code_limiter: security::CodeLimiter::default(),
            password_limiter: security::CodeLimiter::new(10, std::time::Duration::from_secs(600)),
            hub: hub::Hub::default(),
            config,
        }));
        events::listen(state.clone());
        edge::forget_idle_callers(state.clone());
        chunks::reclaim_blobs_periodically(state.clone());
        Ok(state)
    }
}

async fn healthz() -> &'static str {
    "ok\n"
}

/// Bumped when the server stops understanding older clients or starts
/// requiring something of them. A client compares it with the levels it
/// knows and tells the user which side needs updating.
pub const PROTOCOL_LEVEL: u32 = 1;

#[derive(Serialize)]
struct ServerInfo {
    server: &'static str,
    version: &'static str,
    protocol: u32,
    signup: &'static str,
}

/// What this server is, for a client deciding whether it can talk to it.
/// JSON, unlike the rest of the API, so it can be read with nothing but curl.
async fn info(axum::extract::State(state): axum::extract::State<AppState>) -> Json<ServerInfo> {
    Json(ServerInfo {
        server: "mindstream-server",
        version: env!("CARGO_PKG_VERSION"),
        protocol: PROTOCOL_LEVEL,
        signup: match state.config.signup {
            config::SignupPolicy::Open => "open",
            config::SignupPolicy::Invite => "invite",
            config::SignupPolicy::Closed => "closed",
        },
    })
}

pub fn router(state: AppState) -> Router {
    // Paths are written out in full. Nesting a router would make its root
    // answer at `/collection` but not at `/collection/`, and the client
    // always sends the trailing slash.
    // Only the debug-only test reset route reassigns this; release builds
    // keep it immutable.
    #[cfg_attr(not(debug_assertions), allow(unused_mut))]
    let mut api = Router::new()
        .route("/mindstream/info/", get(info))
        .route("/mindstream/usage/", get(limits::usage))
        .route("/mindstream/feed/", get(feed::feed_socket))
        .route("/mindstream/security/", get(security::status))
        .route("/mindstream/totp/enroll/", post(security::enroll_totp))
        .route("/mindstream/totp/confirm/", post(security::confirm_totp))
        .route("/mindstream/totp/disable/", post(security::disable_totp))
        .route(
            "/mindstream/backup-codes/",
            post(security::new_backup_codes),
        )
        .route("/mindstream/recovery/", put(security::set_recovery))
        .route("/mindstream/sessions/", get(security::list_sessions))
        .route(
            "/mindstream/sessions/revoke-others/",
            post(security::revoke_other_sessions),
        )
        .route(
            "/mindstream/sessions/{session}/",
            delete(security::revoke_session),
        )
        .route("/room/", get(rooms::room_socket))
        .route(
            "/collection/{collection}/item/{item}/room-ticket/",
            post(rooms::room_ticket),
        )
        .route("/authentication/is_etebase/", get(auth::is_etebase))
        .route("/authentication/signup/", post(auth::signup))
        .route(
            "/authentication/login_challenge/",
            post(auth::login_challenge),
        )
        .route("/authentication/login/", post(auth::login))
        .route("/authentication/logout/", post(auth::logout))
        .route(
            "/authentication/change_password/",
            post(auth::change_password),
        )
        .route("/authentication/dashboard_url/", post(auth::dashboard_url))
        .route("/authentication/recover/", post(security::recover))
        .route(
            "/authentication/recover/complete/",
            post(security::complete_recovery),
        )
        .route(
            "/collection/",
            get(collections::list_all).post(collections::create_collection),
        )
        .route("/collection/list_multi/", post(collections::list_multi))
        .route(
            "/collection/{collection}/",
            get(collections::fetch_collection),
        )
        .route(
            "/collection/{collection}/item/",
            get(collections::list_items),
        )
        .route(
            "/collection/{collection}/item/fetch_updates/",
            post(collections::fetch_updates),
        )
        .route(
            "/collection/{collection}/item/batch/",
            post(collections::batch),
        )
        .route(
            "/collection/{collection}/item/transaction/",
            post(collections::transaction),
        )
        .route(
            "/collection/{collection}/item/{item}/",
            get(collections::fetch_item),
        )
        .route(
            "/collection/{collection}/item/{item}/revision/",
            get(collections::list_revisions),
        )
        .route(
            "/collection/{collection}/item/{item}/chunk/{chunk}/",
            put(chunks::upload_chunk)
                .layer(DefaultBodyLimit::max(chunks::MAX_CHUNK_UPLOAD_BYTES)),
        )
        .route(
            "/collection/{collection}/item/{item}/chunk/{chunk}/download/",
            get(chunks::download_chunk),
        )
        .route(
            "/collection/{collection}/member/",
            get(sharing::list_members),
        )
        .route(
            "/collection/{collection}/member/leave/",
            post(sharing::leave),
        )
        .route(
            "/collection/{collection}/member/{username}/",
            delete(sharing::remove_member).patch(sharing::modify_member),
        )
        .route("/invitation/incoming/", get(sharing::list_incoming))
        .route(
            "/invitation/incoming/{uid}/",
            get(sharing::fetch_incoming).delete(sharing::reject),
        )
        .route("/invitation/incoming/{uid}/accept/", post(sharing::accept))
        .route(
            "/invitation/outgoing/",
            get(sharing::list_outgoing).post(sharing::invite),
        )
        .route(
            "/invitation/outgoing/fetch_user_profile/",
            get(sharing::fetch_user_profile),
        )
        .route("/invitation/outgoing/{uid}/", delete(sharing::disinvite))
        .route("/mindstream/link/", get(links::list).post(links::create))
        .route("/mindstream/link/{uid}/", delete(links::revoke))
        .route("/mindstream/link/{uid}/open/", post(links::open))
        .route("/mindstream/link/{uid}/claim/", post(links::claim));
    // See the module gate above: release builds never serve this route.
    #[cfg(debug_assertions)]
    if state.config.test_reset {
        api = api.route("/test/authentication/reset/", post(test_reset::reset));
    }

    let mut admin = Router::new();
    if state.config.admin_token().is_some() {
        admin = admin
            .route("/account/{username}/", get(admin_api::account))
            .route(
                "/account/{username}/entitlements/",
                put(admin_api::set_entitlements).delete(admin_api::clear_entitlements),
            );
    }

    // On every answer, whatever produced it. Nothing here is meant to be
    // framed by another site, guessed at by a browser, or named in a referrer.
    let fixed =
        |name, value| SetResponseHeaderLayer::if_not_present(name, HeaderValue::from_static(value));
    Router::new()
        .route("/healthz", get(healthz))
        .route("/join/{uid}", get(join::page))
        .nest("/api/v1", api)
        .nest("/admin/v1", admin)
        .layer(DefaultBodyLimit::max(state.config.max_body_bytes))
        .layer(fixed(header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
        .layer(fixed(header::X_FRAME_OPTIONS, "DENY"))
        .layer(fixed(header::REFERRER_POLICY, "no-referrer"))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Whether `MINDSTREAM_LISTEN` keeps the server on this machine. Anything
/// else may be reachable by strangers, so dangerous settings refuse it.
pub fn listen_is_loopback(listen: &str) -> bool {
    use std::net::ToSocketAddrs;

    if let Ok(addr) = listen.parse::<std::net::SocketAddr>() {
        return addr.ip().is_loopback();
    }
    // A hostname: every address it resolves to must be loopback, and it must
    // resolve to something. Unresolvable or unparsable means not provably
    // loopback, which fails closed.
    if let Some((host, _)) = listen.rsplit_once(':') {
        let host = host.trim_matches(|c| c == '[' || c == ']');
        if let Ok(addrs) = format!("{host}:0").to_socket_addrs() {
            let mut any = false;
            for addr in addrs {
                any = true;
                if !addr.ip().is_loopback() {
                    return false;
                }
            }
            return any;
        }
    }
    false
}

/// Serve until `shutdown` resolves, then let the requests under way finish.
pub async fn serve(
    listener: tokio::net::TcpListener,
    state: AppState,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    // Backstop for the check in main: whoever serves through this function —
    // the binary or a library consumer — refuses the reset route past
    // loopback. Release builds do not contain the route at all.
    if state.config.test_reset && !listen_is_loopback(&state.config.listen) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!(
                "refusing to start with MINDSTREAM_TEST_RESET=true on {}: \
                 the account reset route must only ever listen on loopback",
                state.config.listen
            ),
        ));
    }
    let listener = edge::CappedListener::new(
        listener,
        Arc::clone(&state.connections),
        state.config.trusted_proxies(),
    );
    edge::serve(listener, router(state), shutdown).await;
    Ok(())
}
