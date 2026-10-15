//! Accounts and device sessions.
//!
//! The password never reaches the server. The client derives a signing key
//! from it and proves possession by signing a challenge, so what is stored
//! here is a public key. A successful login creates a session for that
//! device; the server keeps only a hash of its token.

use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, StatusCode};
use ed25519_dalek::{Signature, VerifyingKey};
use serde_bytes::ByteBuf;
use sqlx::PgConnection;

use crate::edge::AuthAttempt;
use crate::error::{ApiError, ApiResult};
use crate::events::{self, Event};
use crate::keys::{hash_session_token, new_session_token, ChallengeCheck};
use crate::links;
use crate::security;
use crate::wire::{
    LoginChallenge, LoginChallengeRequest, LoginResponse, LoginUser, Msgpack, SignedBody,
    SignedRequest, Signup,
};
use crate::AppState;

const MAX_USERNAME_LEN: usize = 64;
const MAX_EMAIL_LEN: usize = 254;
const MAX_KEY_BLOB_LEN: usize = 4096;
/// How stale `last_used_at` may get before a request refreshes it. Keeps
/// ordinary requests from writing to the sessions table.
const LAST_USED_REFRESH: &str = "5 minutes";

/// The account behind a request, established from its session token.
#[derive(Clone, Debug)]
pub struct AuthUser {
    pub account_id: i64,
    pub session_id: i64,
}

fn invalid_token() -> ApiError {
    ApiError::unauthorized("authentication_failed", "Invalid token.")
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> ApiResult<Self> {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Token "))
            .ok_or_else(|| {
                ApiError::unauthorized(
                    "not_authenticated",
                    "Authentication credentials were not provided.",
                )
            })?;

        let idle_days = idle_days(state.config.session_idle_days);
        let row: Option<(i64, i64, bool, bool, bool)> = sqlx::query_as(&format!(
            "SELECT s.id, s.account_id, a.disabled,
                    s.last_used_at < now() - interval '{LAST_USED_REFRESH}',
                    $2 > 0 AND s.last_used_at < now() - make_interval(days => $2)
             FROM sessions s JOIN accounts a ON a.id = s.account_id
             WHERE s.token_hash = $1"
        ))
        .bind(&hash_session_token(token)[..])
        .bind(idle_days)
        .fetch_optional(&state.pool)
        .await?;

        let (session_id, account_id, disabled, stale, idle) = row.ok_or_else(invalid_token)?;
        if disabled {
            return Err(ApiError::unauthorized(
                "user_inactive",
                "User inactive or deleted.",
            ));
        }
        if idle {
            // Unused for too long. The sweep in `events` ends such a session
            // within minutes of its time, but the server may have been down
            // or just started, and this request must not be what revives it.
            end_idle_sessions(
                &state.pool,
                state.config.session_idle_days,
                Some(session_id),
            )
            .await?;
            return Err(invalid_token());
        }
        if stale {
            let pool = state.pool.clone();
            tokio::spawn(async move {
                // Several requests may have seen the same stale timestamp.
                // Once one refreshes it, the others have nothing to write.
                let _ = sqlx::query(&format!(
                    "UPDATE sessions SET last_used_at = now() WHERE id = $1
                     AND last_used_at < now() - interval '{LAST_USED_REFRESH}'"
                ))
                .bind(session_id)
                .execute(&pool)
                .await;
            });
        }
        Ok(Self {
            account_id,
            session_id,
        })
    }
}

/// Usernames go into URL paths unescaped by the client, so they are limited
/// to characters that need no escaping.
pub fn valid_username(username: &str) -> bool {
    (1..=MAX_USERNAME_LEN).contains(&username.len())
        && username
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

pub(crate) fn username_key(username: &str) -> String {
    username.to_ascii_lowercase()
}

#[derive(sqlx::FromRow)]
pub(crate) struct Account {
    pub id: i64,
    pub username: String,
    pub email: String,
    pub version: i16,
    pub salt: Vec<u8>,
    pub login_pubkey: Vec<u8>,
    pub pubkey: Vec<u8>,
    pub encrypted_content: Vec<u8>,
    pub disabled: bool,
    pub recovery_pubkey: Option<Vec<u8>>,
    pub recovery_encrypted_content: Option<Vec<u8>>,
}

async fn find_account(conn: &mut PgConnection, username: &str) -> ApiResult<Option<Account>> {
    Ok(sqlx::query_as(
        "SELECT id, username, email, version, salt, login_pubkey, pubkey, encrypted_content,
                disabled, recovery_pubkey, recovery_encrypted_content
         FROM accounts WHERE username_key = $1",
    )
    .bind(username_key(username))
    .fetch_optional(conn)
    .await?)
}

/// The idle limit as the queries take it. A limit too large for a count of
/// days is as good as none.
fn idle_days(configured: u32) -> i32 {
    i32::try_from(configured).unwrap_or(0)
}

/// End the sessions no device has used for longer than the server allows,
/// or only `only` when it is one of them. Each goes the way a session goes
/// that its device signed out of: the row is deleted and what it had open
/// is closed. Returns the sessions ended.
///
/// A session is used by every request its device makes, and a device that
/// is running syncs. So this reaches devices that were put away, sold or
/// lost, whose sessions would otherwise stand for ever.
pub(crate) async fn end_idle_sessions(
    pool: &sqlx::PgPool,
    configured_days: u32,
    only: Option<i64>,
) -> Result<Vec<i64>, sqlx::Error> {
    let days = idle_days(configured_days);
    if days == 0 {
        return Ok(Vec::new());
    }
    let mut tx = pool.begin().await?;
    let ended: Vec<i64> = sqlx::query_scalar(
        "DELETE FROM sessions
         WHERE last_used_at < now() - make_interval(days => $1)
           AND ($2::bigint IS NULL OR id = $2)
         RETURNING id",
    )
    .bind(days)
    .bind(only)
    .fetch_all(&mut *tx)
    .await?;
    for session in &ended {
        events::publish(&mut tx, &Event::SessionClosed { session: *session }).await?;
    }
    tx.commit().await?;
    Ok(ended)
}

/// Which of these sessions still stand: the session exists and its account
/// is not disabled. A socket is open on the strength of the session that
/// opened it, and this is how the sockets are held to that.
pub(crate) async fn standing_sessions(
    pool: &sqlx::PgPool,
    sessions: &[i64],
) -> Result<Vec<i64>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT s.id FROM sessions s
         JOIN accounts a ON a.id = s.account_id AND NOT a.disabled
         WHERE s.id = ANY($1)",
    )
    .bind(sessions)
    .fetch_all(pool)
    .await
}

/// Take the account's turn at changing how it is secured, until the
/// transaction ends.
///
/// Signing in, a new password, a recovery, and setting up or removing a
/// second factor each read the account's credentials and then act on what
/// they read. Unless they take turns, a sign-in that has checked the old
/// password can open its session after a password change has ended every
/// other one, and the change would have achieved nothing against whoever
/// knew the old password.
///
/// Every such path takes this lock first, in a transaction, before it reads
/// anything it will act on. `FOR NO KEY UPDATE` is the lock an ordinary
/// update of the row takes, so it also takes turns with an administrator
/// disabling the account, and it does not hold up the rows that merely
/// refer to the account.
pub(crate) async fn lock_account(conn: &mut PgConnection, account_id: i64) -> ApiResult<()> {
    sqlx::query("SELECT 1 FROM accounts WHERE id = $1 FOR NO KEY UPDATE")
        .bind(account_id)
        .execute(conn)
        .await?;
    Ok(())
}

/// Find an account and take its turn, see [`lock_account`]. The row comes
/// back as it is once the turn is ours, so a password changed while we
/// waited is the one we get.
async fn find_account_for_change(
    conn: &mut PgConnection,
    username: &str,
) -> ApiResult<Option<Account>> {
    Ok(sqlx::query_as(
        "SELECT id, username, email, version, salt, login_pubkey, pubkey, encrypted_content,
                disabled, recovery_pubkey, recovery_encrypted_content
         FROM accounts WHERE username_key = $1
         FOR NO KEY UPDATE",
    )
    .bind(username_key(username))
    .fetch_optional(conn)
    .await?)
}

fn user_not_found() -> ApiError {
    ApiError::unauthorized("user_not_found", "User not found")
}

fn device_name(headers: &HeaderMap) -> String {
    headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .chars()
        .take(200)
        .collect()
}

/// Start a session for a device. `second_factor` records that it got here
/// by proving one.
pub(crate) async fn open_session(
    conn: &mut PgConnection,
    account: Account,
    headers: &HeaderMap,
    second_factor: bool,
) -> ApiResult<LoginResponse> {
    let (token, hash) = new_session_token();
    sqlx::query(
        "INSERT INTO sessions (account_id, token_hash, device_name, second_factor_at)
         VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END)",
    )
    .bind(account.id)
    .bind(&hash[..])
    .bind(device_name(headers))
    .bind(second_factor)
    .execute(conn)
    .await?;
    Ok(LoginResponse {
        token,
        user: LoginUser {
            username: account.username,
            email: account.email,
            pubkey: ByteBuf::from(account.pubkey),
            encrypted_content: ByteBuf::from(account.encrypted_content),
        },
    })
}

pub async fn is_etebase() -> StatusCode {
    StatusCode::OK
}

pub(crate) fn validate_signup(body: &Signup) -> ApiResult<()> {
    if !valid_username(&body.user.username) {
        return Err(ApiError::bad_request(
            "Usernames may contain letters, digits, '.', '_' and '-', up to 64 characters.",
        ));
    }
    if body.user.email.is_empty() || body.user.email.len() > MAX_EMAIL_LEN {
        return Err(ApiError::bad_request("An email address is required."));
    }
    if body.login_pubkey.len() != 32 || body.pubkey.len() != 32 {
        return Err(ApiError::bad_request("Malformed public key."));
    }
    if body.salt.is_empty() || body.salt.len() > 64 {
        return Err(ApiError::bad_request("Malformed account keys."));
    }
    validate_account_keys(&body.login_pubkey, &body.encrypted_content)?;
    match (&body.recovery_pubkey, &body.recovery_encrypted_content) {
        (None, None) => Ok(()),
        (Some(pubkey), Some(content)) => validate_recovery_key(pubkey, content),
        _ => Err(ApiError::bad_request(
            "A recovery key comes with its copy of the account keys.",
        )),
    }
}

/// The key a password proves and the account keys wrapped under it.
pub(crate) fn validate_account_keys(
    login_pubkey: &[u8],
    encrypted_content: &[u8],
) -> ApiResult<()> {
    if login_pubkey.len() != 32
        || encrypted_content.is_empty()
        || encrypted_content.len() > MAX_KEY_BLOB_LEN
    {
        return Err(ApiError::bad_request("Malformed account keys."));
    }
    Ok(())
}

pub(crate) fn validate_recovery_key(pubkey: &[u8], encrypted_content: &[u8]) -> ApiResult<()> {
    if pubkey.len() != 32
        || encrypted_content.is_empty()
        || encrypted_content.len() > MAX_KEY_BLOB_LEN
    {
        return Err(ApiError::bad_request("Malformed recovery key."));
    }
    Ok(())
}

pub(crate) async fn insert_account(conn: &mut PgConnection, body: &Signup) -> ApiResult<i64> {
    let inserted: Option<i64> = sqlx::query_scalar(
        "INSERT INTO accounts
             (username, username_key, email, version, salt, login_pubkey, pubkey, encrypted_content,
              recovery_pubkey, recovery_encrypted_content)
         VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (username_key) DO NOTHING
         RETURNING id",
    )
    .bind(&body.user.username)
    .bind(username_key(&body.user.username))
    .bind(&body.user.email)
    .bind(&body.salt[..])
    .bind(&body.login_pubkey[..])
    .bind(&body.pubkey[..])
    .bind(&body.encrypted_content[..])
    .bind(body.recovery_pubkey.as_ref().map(|key| &key[..]))
    .bind(body.recovery_encrypted_content.as_ref().map(|c| &c[..]))
    .fetch_optional(conn)
    .await?;
    inserted.ok_or_else(|| {
        ApiError::conflict("user_exists", "A user with that username already exists.")
    })
}

pub async fn signup(
    State(state): State<AppState>,
    _attempt: AuthAttempt,
    headers: HeaderMap,
    Msgpack(body): Msgpack<Signup>,
) -> ApiResult<Msgpack<LoginResponse>> {
    validate_signup(&body)?;

    let mut tx = state.pool.begin().await?;
    let grant = links::signup_grant(&state, &mut tx, &body).await?;
    let account_id = insert_account(&mut tx, &body).await?;
    links::redeem(&mut tx, grant, account_id).await?;
    let account = find_account(&mut tx, &body.user.username)
        .await?
        .ok_or_else(|| ApiError::internal("account vanished during signup"))?;
    let response = open_session(&mut tx, account, &headers, false).await?;
    tx.commit().await?;
    Ok(Msgpack(response))
}

pub async fn login_challenge(
    State(state): State<AppState>,
    _attempt: AuthAttempt,
    Msgpack(body): Msgpack<LoginChallengeRequest>,
) -> ApiResult<Msgpack<LoginChallenge>> {
    let mut conn = state.pool.acquire().await?;
    let account = find_account(&mut conn, &body.username)
        .await?
        .ok_or_else(user_not_found)?;
    Ok(Msgpack(LoginChallenge {
        challenge: ByteBuf::from(state.keys.challenge(account.id)),
        salt: ByteBuf::from(account.salt),
        version: account.version,
    }))
}

fn strip_port(host: &str) -> &str {
    // An IPv6 literal keeps its brackets and loses only what follows them.
    if let Some(end) = host.rfind(']') {
        return &host[..=end];
    }
    host.rsplit_once(':').map_or(host, |(name, _)| name)
}

/// A login names the host it was made for. Refusing one made for another
/// host stops a server that a user was tricked into logging in to from
/// replaying that login here.
///
/// With `public_hosts` configured, the claim must be one of them. Otherwise
/// it must match the request's own Host header; a request without one is
/// refused, since a missing Host says nothing about where the login was
/// really made for.
fn host_allowed(public_hosts: &[String], request_host: Option<&str>, claimed: &str) -> bool {
    let claimed = strip_port(claimed);
    // An unset variable arrives as one empty name, which configures nothing.
    let mut configured = public_hosts
        .iter()
        .filter(|host| !host.is_empty())
        .peekable();
    if configured.peek().is_some() {
        return configured.any(|host| strip_port(host).eq_ignore_ascii_case(claimed));
    }
    request_host.is_some_and(|host| strip_port(host).eq_ignore_ascii_case(claimed))
}

fn host_matches(state: &AppState, headers: &HeaderMap, claimed: &str) -> bool {
    let request_host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    host_allowed(&state.config.public_hosts, request_host, claimed)
}

/// Which of an account's keys a request has to be signed with.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum SignedBy {
    /// The key derived from the password.
    Password,
    /// The key derived from the recovery secret.
    RecoveryKey,
}

/// Check everything a signed request claims, and return the account it is
/// for along with the decoded body.
///
/// `conn` has to be a transaction: this takes the account's turn at changing
/// how it is secured, see [`lock_account`], and the turn lasts as long as
/// the transaction does. What the caller goes on to do with the account
/// belongs in the same one.
pub(crate) async fn verify_signed(
    state: &AppState,
    conn: &mut PgConnection,
    headers: &HeaderMap,
    request: &SignedRequest,
    action: &str,
    signed_by: SignedBy,
) -> ApiResult<(Account, SignedBody)> {
    let body: SignedBody = rmp_serde::from_slice(&request.response)
        .map_err(|err| ApiError::bad_request(format!("Malformed login response: {err}")))?;

    let account = find_account_for_change(conn, &body.username)
        .await?
        .ok_or_else(user_not_found)?;
    if body.action != action {
        return Err(ApiError::bad_request(format!(
            "Expected \"{action}\" but got something else."
        )));
    }
    if !host_matches(state, headers, &body.host) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "wrong_host",
            format!("This login was made for \"{}\".", body.host),
        ));
    }
    let (nonce, expires) = match state.keys.verify_challenge(&body.challenge, account.id) {
        ChallengeCheck::Valid { nonce, expires } => (nonce, expires),
        ChallengeCheck::Expired => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "challenge_expired",
                "Login challenge has expired",
            ))
        }
        ChallengeCheck::Invalid => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "bad_challenge",
                "Login challenge is not one this server issued",
            ))
        }
    };

    let bad_signature = || match signed_by {
        SignedBy::Password => {
            ApiError::unauthorized("login_bad_signature", "Wrong password for user.")
        }
        SignedBy::RecoveryKey => {
            ApiError::unauthorized("recovery_bad_signature", "Wrong recovery key for user.")
        }
    };
    let stored = match signed_by {
        SignedBy::Password => Some(&account.login_pubkey),
        // An account without a recovery key answers like one given the
        // wrong key, so asking does not reveal which accounts have one.
        SignedBy::RecoveryKey => account.recovery_pubkey.as_ref(),
    };
    let key_bytes: [u8; 32] = stored
        .ok_or_else(bad_signature)?
        .as_slice()
        .try_into()
        .map_err(|_| ApiError::internal("a stored public key has the wrong length"))?;
    // A password proof is held to its account's throttle before it is
    // checked, so the check itself cannot be used to guess without bound.
    // In memory, like the second-factor throttle: no database round-trip,
    // so concurrent logins cannot wedge the pool waiting on each other.
    if signed_by == SignedBy::Password && state.password_limiter.blocked(account.id) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "password_throttled",
            "Too many wrong passwords. Wait ten minutes and try again.",
        ));
    }
    let key = VerifyingKey::from_bytes(&key_bytes).map_err(|_| bad_signature())?;
    let signature = Signature::from_slice(&request.signature).map_err(|_| bad_signature())?;
    if key.verify_strict(&request.response, &signature).is_err() {
        if signed_by == SignedBy::Password {
            state.password_limiter.failed(account.id);
        }
        return Err(bad_signature());
    }
    if signed_by == SignedBy::Password {
        state.password_limiter.clear(account.id);
    }

    if account.disabled {
        return Err(ApiError::unauthorized(
            "user_inactive",
            "User inactive or deleted.",
        ));
    }
    spend_challenge(conn, &nonce, expires).await?;
    Ok((account, body))
}

/// A challenge answers one request. It is spent in the caller's
/// transaction, so a request that fails leaves it to be answered again,
/// and of two copies of one request only the first goes through.
async fn spend_challenge(conn: &mut PgConnection, nonce: &[u8], expires: u64) -> ApiResult<()> {
    let fresh = sqlx::query(
        "INSERT INTO spent_challenges (nonce, expires_at) VALUES ($1, to_timestamp($2))
         ON CONFLICT DO NOTHING",
    )
    .bind(nonce)
    .bind(expires as f64)
    .execute(conn)
    .await?
    .rows_affected()
        == 1;
    if fresh {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "challenge_used",
            "This login challenge has been answered already. Ask for another.",
        ))
    }
}

/// Forget the spent challenges that have expired, which no request can
/// answer any more.
pub(crate) async fn forget_spent_challenges(pool: &sqlx::PgPool) -> Result<u64, sqlx::Error> {
    Ok(
        sqlx::query("DELETE FROM spent_challenges WHERE expires_at < now()")
            .execute(pool)
            .await?
            .rows_affected(),
    )
}

/// A signed request from a device that is signed in: the password proven
/// again, for the account the session belongs to.
pub(crate) async fn verify_own(
    state: &AppState,
    conn: &mut PgConnection,
    headers: &HeaderMap,
    user: &AuthUser,
    request: &SignedRequest,
    action: &str,
) -> ApiResult<(Account, SignedBody)> {
    let (account, body) =
        verify_signed(state, conn, headers, request, action, SignedBy::Password).await?;
    if account.id != user.account_id {
        return Err(ApiError::forbidden(
            "wrong_user",
            "This request was signed for another account.",
        ));
    }
    Ok((account, body))
}

pub async fn login(
    State(state): State<AppState>,
    _attempt: AuthAttempt,
    headers: HeaderMap,
    Msgpack(request): Msgpack<SignedRequest>,
) -> ApiResult<Msgpack<LoginResponse>> {
    // Checking the password, spending the code and opening the session are
    // one step. A password change waits for it or goes first, and in neither
    // case does a session open on a password that no longer stands.
    let mut tx = state.pool.begin().await?;
    let (account, body) = verify_signed(
        &state,
        &mut tx,
        &headers,
        &request,
        "login",
        SignedBy::Password,
    )
    .await?;
    // Asked for only once the password has been proven, so the answer does
    // not tell a stranger which accounts have a second factor.
    let second_factor =
        security::check_second_factor(&state, &mut tx, account.id, body.totp.as_deref()).await?;
    let session = open_session(&mut tx, account, &headers, second_factor).await?;
    tx.commit().await?;
    Ok(Msgpack(session))
}

pub async fn logout(State(state): State<AppState>, user: AuthUser) -> ApiResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM sessions WHERE id = $1")
        .bind(user.session_id)
        .execute(&mut *tx)
        .await?;
    let closed = Event::SessionClosed {
        session: user.session_id,
    };
    events::publish(&mut tx, &closed).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Replace the login key and the wrapped account keys. Signed with the old
/// login key, so a session token alone cannot change the password.
///
/// Every other device is signed out. A password is often changed because
/// someone else may know it, and whoever that is may be signed in.
pub async fn change_password(
    State(state): State<AppState>,
    _attempt: AuthAttempt,
    user: AuthUser,
    headers: HeaderMap,
    Msgpack(request): Msgpack<SignedRequest>,
) -> ApiResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let (account, body) =
        verify_own(&state, &mut tx, &headers, &user, &request, "changePassword").await?;
    let (Some(login_pubkey), Some(encrypted_content)) = (body.login_pubkey, body.encrypted_content)
    else {
        return Err(ApiError::bad_request("Missing the new account keys."));
    };
    validate_account_keys(&login_pubkey, &encrypted_content)?;
    security::check_second_factor(&state, &mut tx, account.id, body.totp.as_deref()).await?;
    sqlx::query("UPDATE accounts SET login_pubkey = $2, encrypted_content = $3 WHERE id = $1")
        .bind(account.id)
        .bind(&login_pubkey[..])
        .bind(&encrypted_content[..])
        .execute(&mut *tx)
        .await?;
    security::close_sessions(&mut tx, account.id, Some(user.session_id)).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Etebase's hosted service has a web dashboard. This server does not.
pub async fn dashboard_url(_user: AuthUser) -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "not_supported",
        "This server doesn't have a user dashboard.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usernames_are_limited_to_path_safe_characters() {
        assert!(valid_username("test_user"));
        assert!(valid_username("bench-owner-1.x"));
        assert!(!valid_username(""));
        assert!(!valid_username("a/b"));
        assert!(!valid_username("a b"));
        assert!(!valid_username("a%2Fb"));
        assert!(!valid_username(&"a".repeat(65)));
    }

    #[test]
    fn login_is_refused_for_another_host() {
        // The Rust client names the host without a port, the JavaScript one
        // with it.
        assert!(host_allowed(
            &[],
            Some("notes.example.com:443"),
            "notes.example.com"
        ));
        assert!(host_allowed(
            &[],
            Some("localhost:18080"),
            "localhost:18080"
        ));
        assert!(host_allowed(
            &[],
            Some("Notes.Example.com"),
            "notes.example.com"
        ));
        assert!(!host_allowed(
            &[],
            Some("notes.example.com"),
            "evil.example.com"
        ));

        // Behind a proxy that rewrites Host, the configured names decide.
        let public = vec!["notes.example.com".to_string()];
        assert!(host_allowed(
            &public,
            Some("server:3735"),
            "notes.example.com"
        ));
        assert!(!host_allowed(&public, Some("server:3735"), "server"));

        // An empty setting is the same as none.
        let unset = vec![String::new()];
        assert!(host_allowed(
            &unset,
            Some("localhost:18090"),
            "localhost:18090"
        ));
        assert!(!host_allowed(&unset, Some("localhost:18090"), "elsewhere"));
        // Without a Host header there is nothing to compare against, so the
        // login is refused rather than let through — unless the expected
        // names are configured, in which case they decide on their own.
        assert!(!host_allowed(&[], None, "localhost:18090"));
        assert!(!host_allowed(&unset, None, "localhost:18090"));
        assert!(host_allowed(&public, None, "notes.example.com"));
        assert!(!host_allowed(&public, None, "evil.example.com"));
    }

    #[test]
    fn port_is_ignored_when_comparing_hosts() {
        assert_eq!(strip_port("localhost:18080"), "localhost");
        assert_eq!(strip_port("localhost"), "localhost");
        assert_eq!(strip_port("[::1]:8080"), "[::1]");
        assert_eq!(strip_port("[::1]"), "[::1]");
    }
}
