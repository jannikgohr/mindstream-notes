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

use crate::config::SignupPolicy;
use crate::error::{ApiError, ApiResult};
use crate::keys::{hash_session_token, new_session_token, ChallengeCheck};
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

        let row: Option<(i64, i64, bool, bool)> = sqlx::query_as(&format!(
            "SELECT s.id, s.account_id, a.disabled,
                    s.last_used_at < now() - interval '{LAST_USED_REFRESH}'
             FROM sessions s JOIN accounts a ON a.id = s.account_id
             WHERE s.token_hash = $1"
        ))
        .bind(&hash_session_token(token)[..])
        .fetch_optional(&state.pool)
        .await?;

        let (session_id, account_id, disabled, stale) = row.ok_or_else(invalid_token)?;
        if disabled {
            return Err(ApiError::unauthorized(
                "user_inactive",
                "User inactive or deleted.",
            ));
        }
        if stale {
            let pool = state.pool.clone();
            tokio::spawn(async move {
                let _ = sqlx::query("UPDATE sessions SET last_used_at = now() WHERE id = $1")
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

pub fn username_key(username: &str) -> String {
    username.to_ascii_lowercase()
}

#[derive(sqlx::FromRow)]
struct Account {
    id: i64,
    username: String,
    email: String,
    version: i16,
    salt: Vec<u8>,
    login_pubkey: Vec<u8>,
    pubkey: Vec<u8>,
    encrypted_content: Vec<u8>,
    disabled: bool,
}

async fn find_account(conn: &mut PgConnection, username: &str) -> ApiResult<Option<Account>> {
    Ok(sqlx::query_as(
        "SELECT id, username, email, version, salt, login_pubkey, pubkey, encrypted_content, disabled
         FROM accounts WHERE username_key = $1",
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

async fn open_session(
    conn: &mut PgConnection,
    account: Account,
    headers: &HeaderMap,
) -> ApiResult<LoginResponse> {
    let (token, hash) = new_session_token();
    sqlx::query("INSERT INTO sessions (account_id, token_hash, device_name) VALUES ($1, $2, $3)")
        .bind(account.id)
        .bind(&hash[..])
        .bind(device_name(headers))
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
    if body.salt.is_empty()
        || body.salt.len() > 64
        || body.encrypted_content.is_empty()
        || body.encrypted_content.len() > MAX_KEY_BLOB_LEN
    {
        return Err(ApiError::bad_request("Malformed account keys."));
    }
    Ok(())
}

pub(crate) async fn insert_account(conn: &mut PgConnection, body: &Signup) -> ApiResult<i64> {
    let inserted: Option<i64> = sqlx::query_scalar(
        "INSERT INTO accounts
             (username, username_key, email, version, salt, login_pubkey, pubkey, encrypted_content)
         VALUES ($1, $2, $3, 1, $4, $5, $6, $7)
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
    .fetch_optional(conn)
    .await?;
    inserted.ok_or_else(|| {
        ApiError::conflict("user_exists", "A user with that username already exists.")
    })
}

pub async fn signup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Msgpack(body): Msgpack<Signup>,
) -> ApiResult<Msgpack<LoginResponse>> {
    if state.config.signup != SignupPolicy::Open {
        return Err(ApiError::forbidden(
            "signup_closed",
            "This server does not accept signups.",
        ));
    }
    validate_signup(&body)?;

    let mut tx = state.pool.begin().await?;
    insert_account(&mut tx, &body).await?;
    let account = find_account(&mut tx, &body.user.username)
        .await?
        .ok_or_else(|| ApiError::internal("account vanished during signup"))?;
    let response = open_session(&mut tx, account, &headers).await?;
    tx.commit().await?;
    Ok(Msgpack(response))
}

pub async fn login_challenge(
    State(state): State<AppState>,
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
/// it must match the request's own Host header; a request without one is let
/// through, since there is nothing to compare against.
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
    request_host.is_none_or(|host| strip_port(host).eq_ignore_ascii_case(claimed))
}

fn host_matches(state: &AppState, headers: &HeaderMap, claimed: &str) -> bool {
    let request_host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    host_allowed(&state.config.public_hosts, request_host, claimed)
}

/// Check everything a signed request claims, and return the account it is
/// for along with the decoded body.
async fn verify_signed(
    state: &AppState,
    conn: &mut PgConnection,
    headers: &HeaderMap,
    request: &SignedRequest,
    action: &str,
) -> ApiResult<(Account, SignedBody)> {
    let body: SignedBody = rmp_serde::from_slice(&request.response)
        .map_err(|err| ApiError::bad_request(format!("Malformed login response: {err}")))?;

    let account = find_account(conn, &body.username)
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
    match state.keys.verify_challenge(&body.challenge, account.id) {
        ChallengeCheck::Valid => {}
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
    }

    let bad_signature =
        || ApiError::unauthorized("login_bad_signature", "Wrong password for user.");
    let key_bytes: [u8; 32] = account.login_pubkey[..]
        .try_into()
        .map_err(|_| ApiError::internal("stored login key has the wrong length"))?;
    let key = VerifyingKey::from_bytes(&key_bytes).map_err(|_| bad_signature())?;
    let signature = Signature::from_slice(&request.signature).map_err(|_| bad_signature())?;
    key.verify_strict(&request.response, &signature)
        .map_err(|_| bad_signature())?;

    if account.disabled {
        return Err(ApiError::unauthorized(
            "user_inactive",
            "User inactive or deleted.",
        ));
    }
    Ok((account, body))
}

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Msgpack(request): Msgpack<SignedRequest>,
) -> ApiResult<Msgpack<LoginResponse>> {
    let mut conn = state.pool.acquire().await?;
    let (account, _) = verify_signed(&state, &mut conn, &headers, &request, "login").await?;
    Ok(Msgpack(open_session(&mut conn, account, &headers).await?))
}

pub async fn logout(State(state): State<AppState>, user: AuthUser) -> ApiResult<StatusCode> {
    sqlx::query("DELETE FROM sessions WHERE id = $1")
        .bind(user.session_id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Replace the login key and the wrapped account keys. Signed with the old
/// login key, so a session token alone cannot change the password.
pub async fn change_password(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    Msgpack(request): Msgpack<SignedRequest>,
) -> ApiResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let (account, body) =
        verify_signed(&state, &mut tx, &headers, &request, "changePassword").await?;
    if account.id != user.account_id {
        return Err(ApiError::forbidden(
            "wrong_user",
            "This request was signed for another account.",
        ));
    }
    let (Some(login_pubkey), Some(encrypted_content)) = (body.login_pubkey, body.encrypted_content)
    else {
        return Err(ApiError::bad_request("Missing the new account keys."));
    };
    if login_pubkey.len() != 32
        || encrypted_content.is_empty()
        || encrypted_content.len() > MAX_KEY_BLOB_LEN
    {
        return Err(ApiError::bad_request("Malformed account keys."));
    }
    sqlx::query("UPDATE accounts SET login_pubkey = $2, encrypted_content = $3 WHERE id = $1")
        .bind(account.id)
        .bind(&login_pubkey[..])
        .bind(&encrypted_content[..])
        .execute(&mut *tx)
        .await?;
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
    }

    #[test]
    fn port_is_ignored_when_comparing_hosts() {
        assert_eq!(strip_port("localhost:18080"), "localhost");
        assert_eq!(strip_port("localhost"), "localhost");
        assert_eq!(strip_port("[::1]:8080"), "[::1]");
        assert_eq!(strip_port("[::1]"), "[::1]");
    }
}
