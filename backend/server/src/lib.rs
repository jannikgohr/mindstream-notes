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
mod keys;
pub mod limits;
mod rooms;
mod sharing;
mod test_reset;
#[cfg(test)]
mod testing;
mod wire;

use std::net::SocketAddr;
use std::ops::Deref;
use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::Serialize;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tower_http::trace::TraceLayer;

use blob::BlobStore;
pub use config::Config;
use keys::Keys;

pub struct Inner {
    pub(crate) pool: PgPool,
    pub(crate) blobs: BlobStore,
    pub(crate) keys: Keys,
    pub(crate) auth_limiter: edge::RateLimiter,
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
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::Database(err) => write!(f, "database: {err}"),
            StartError::Migration(err) => write!(f, "migration: {err}"),
            StartError::Blobs(err) => write!(f, "blob directory: {err}"),
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
        let auth_limiter =
            edge::RateLimiter::new(config.auth_rate_per_minute, config.auth_rate_burst);
        let state = Self(Arc::new(Inner {
            pool,
            blobs,
            keys,
            auth_limiter,
            hub: hub::Hub::default(),
            config,
        }));
        events::listen(state.clone());
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
            config::SignupPolicy::Closed => "closed",
        },
    })
}

pub fn router(state: AppState) -> Router {
    // Paths are written out in full. Nesting a router would make its root
    // answer at `/collection` but not at `/collection/`, and the client
    // always sends the trailing slash.
    let mut api = Router::new()
        .route("/mindstream/info/", get(info))
        .route("/mindstream/usage/", get(limits::usage))
        .route("/mindstream/feed/", get(feed::feed_socket))
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
            put(chunks::upload_chunk),
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
        .route("/invitation/outgoing/{uid}/", delete(sharing::disinvite));
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

    Router::new()
        .route("/healthz", get(healthz))
        .nest("/api/v1", api)
        .nest("/admin/v1", admin)
        .layer(DefaultBodyLimit::max(state.config.max_body_bytes))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Serve until the listener fails or `shutdown` resolves.
pub async fn serve(
    listener: tokio::net::TcpListener,
    state: AppState,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    // Handlers need the peer address to work out who is calling.
    let service = router(state).into_make_service_with_connect_info::<SocketAddr>();
    axum::serve(listener, service)
        .with_graceful_shutdown(shutdown)
        .await
}
