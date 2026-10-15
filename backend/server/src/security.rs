//! What protects an account beyond its password: a second factor, backup
//! codes, a recovery key, and the list of devices signed in.
//!
//! Anything here that would let someone take an account over is a signed
//! request. The caller proves the password again, strictly the key derived
//! from it, and where a second factor is in use the signed body carries a
//! code as well. A session token alone opens none of it.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use argon2::{Algorithm, Argon2, Params, Version};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use sqlx::PgConnection;

use crate::auth::{self, AuthUser, SignedBy};
use crate::edge::AuthAttempt;
use crate::error::{ApiError, ApiResult};
use crate::events::{self, Event};
use crate::keys::{now_secs, random_bytes};
use crate::totp;
use crate::wire::{LoginResponse, Msgpack, SignedRequest};
use crate::AppState;

/// Wrong codes an account may get through before it has to wait.
const MAX_CODE_FAILURES: u32 = 5;
const CODE_FAILURE_WINDOW: Duration = Duration::from_secs(10 * 60);

/// Counts wrong guesses per account: a password or a six-digit code is only
/// as strong as the number of guesses allowed at it.
///
/// Kept in memory. A restart forgets the counts and a second process keeps
/// its own, which loosens the limit by a small constant and no more.
pub struct CodeLimiter {
    max_failures: u32,
    window: Duration,
    failures: Mutex<HashMap<i64, (u32, Instant)>>,
}

impl Default for CodeLimiter {
    /// The second-factor throttle: five wrong codes in ten minutes.
    fn default() -> Self {
        Self::new(MAX_CODE_FAILURES, CODE_FAILURE_WINDOW)
    }
}

impl CodeLimiter {
    pub(crate) fn new(max_failures: u32, window: Duration) -> Self {
        Self {
            max_failures,
            window,
            failures: Mutex::new(HashMap::new()),
        }
    }

    fn blocked_at(&self, account_id: i64, now: Instant) -> bool {
        let mut failures = self.failures.lock().unwrap_or_else(|e| e.into_inner());
        match failures.get(&account_id) {
            Some((_, since)) if now.duration_since(*since) > self.window => {
                failures.remove(&account_id);
                false
            }
            Some((count, _)) => *count >= self.max_failures,
            None => false,
        }
    }

    fn failed_at(&self, account_id: i64, now: Instant) {
        let mut failures = self.failures.lock().unwrap_or_else(|e| e.into_inner());
        failures.retain(|_, (_, since)| now.duration_since(*since) <= self.window);
        failures.entry(account_id).or_insert((0, now)).0 += 1;
    }

    pub(crate) fn blocked(&self, account_id: i64) -> bool {
        self.blocked_at(account_id, Instant::now())
    }

    pub(crate) fn failed(&self, account_id: i64) {
        self.failed_at(account_id, Instant::now());
    }

    pub(crate) fn clear(&self, account_id: i64) {
        self.failures
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&account_id);
    }
}

const BACKUP_CODES: usize = 10;
/// Characters in a backup code, five bits each.
const BACKUP_CODE_LEN: usize = 10;

fn code_required() -> ApiError {
    ApiError::unauthorized(
        "totp_required",
        "Enter the code from your authenticator app.",
    )
}

fn code_invalid() -> ApiError {
    ApiError::unauthorized("totp_invalid", "That code is not valid.")
}

fn throttled() -> ApiError {
    ApiError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "totp_throttled",
        "Too many wrong codes. Wait ten minutes and try again.",
    )
}

fn not_enrolled() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "totp_not_enabled",
        "This account has no authenticator set up.",
    )
}

/// A code as typed, without the spaces and dashes people and apps add.
fn normalise(code: &str) -> String {
    code.chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// Backup codes are letters and digits and longer than six characters, so
/// six digits can only be a code from the authenticator.
fn looks_like_totp(code: &str) -> bool {
    code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit())
}

fn new_backup_code() -> String {
    // The first ten characters are the first fifty bits, all of them random.
    totp::base32(&random_bytes::<8>())[..BACKUP_CODE_LEN].to_owned()
}

/// The form a backup code is shown in: two groups, easier to copy by hand.
fn display_backup_code(code: &str) -> String {
    let (head, tail) = code.split_at(BACKUP_CODE_LEN / 2);
    format!("{head}-{tail}")
}

/// Hash a backup code with Argon2id, so a database read hands out nothing
/// that opens an account. Unsalted fast hashes fell to offline brute force
/// at fifty bits; these do not.
fn argon2() -> Argon2<'static> {
    // Nineteen megabytes and two passes: far past what fifty random bits
    // need, while a rare backup-code sign-in still waits well under a second
    // even trying every unused code in turn.
    Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(19 * 1024, 2, 1, None).expect("valid parameters"),
    )
}

fn hash_backup_code(normalised: &str) -> ApiResult<String> {
    argon2()
        .hash_password_with_salt(normalised.as_bytes(), &random_bytes::<16>())
        .map(|hash| hash.to_string())
        .map_err(|err| ApiError::internal(format!("a backup code could not be hashed: {err}")))
}

fn backup_code_matches(stored: &str, normalised: &str) -> bool {
    argon2()
        .verify_password(normalised.as_bytes(), stored)
        .is_ok()
}

fn open_secret(state: &AppState, sealed: &[u8]) -> ApiResult<Vec<u8>> {
    state.vault.open(sealed).ok_or_else(|| {
        ApiError::internal(
            "an authenticator secret cannot be read. The secret key is not the one it was \
             stored under",
        )
    })
}

/// Whether the account has a second factor in use.
pub(crate) async fn enrolled(
    conn: &mut PgConnection,
    account_id: i64,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM second_factors
                        WHERE account_id = $1 AND confirmed_at IS NOT NULL)",
    )
    .bind(account_id)
    .fetch_one(conn)
    .await
}

/// Hold the caller to the account's second factor, if it has one. Returns
/// whether there was one to prove.
///
/// Call it only once the password has been proven. Its answers say whether
/// the account has a second factor, which a stranger has no business
/// learning.
pub(crate) async fn check_second_factor(
    state: &AppState,
    conn: &mut PgConnection,
    account_id: i64,
    code: Option<&str>,
) -> ApiResult<bool> {
    let factor: Option<(i64, Vec<u8>, i64)> = sqlx::query_as(
        "SELECT id, secret, last_step FROM second_factors
         WHERE account_id = $1 AND kind = 'totp' AND confirmed_at IS NOT NULL",
    )
    .bind(account_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((factor_id, sealed, last_step)) = factor else {
        return Ok(false);
    };
    let code = code
        .map(normalise)
        .filter(|code| !code.is_empty())
        .ok_or_else(code_required)?;
    if state.code_limiter.blocked(account_id) {
        return Err(throttled());
    }

    let accepted = if looks_like_totp(&code) {
        let secret = open_secret(state, &sealed)?;
        match totp::verify(&secret, &code, now_secs(), last_step as u64) {
            // Two requests carrying the same code both get this far. The
            // update lets exactly one of them through.
            Some(step) => {
                sqlx::query(
                    "UPDATE second_factors SET last_step = $2 WHERE id = $1 AND last_step < $2",
                )
                .bind(factor_id)
                .bind(step as i64)
                .execute(&mut *conn)
                .await?
                .rows_affected()
                    == 1
            }
            None => false,
        }
    } else {
        // Argon2 cannot be compared inside the database, so the unused
        // hashes come out and each is tried in turn. Spending one is still
        // atomic: the update only lands on a code nobody used first, so of
        // two requests racing with the same code exactly one gets through.
        let candidates: Vec<(i64, String)> = sqlx::query_as(
            "SELECT id, code_hash FROM backup_codes
              WHERE account_id = $1 AND used_at IS NULL",
        )
        .bind(account_id)
        .fetch_all(&mut *conn)
        .await?;
        let mut spent = None;
        for (id, hash) in &candidates {
            if backup_code_matches(hash, &code) {
                spent = Some(*id);
                break;
            }
        }
        match spent {
            Some(id) => {
                sqlx::query(
                    "UPDATE backup_codes SET used_at = now()
                      WHERE id = $1 AND used_at IS NULL",
                )
                .bind(id)
                .execute(&mut *conn)
                .await?
                .rows_affected()
                    == 1
            }
            None => false,
        }
    };

    if accepted {
        state.code_limiter.clear(account_id);
        Ok(true)
    } else {
        state.code_limiter.failed(account_id);
        Err(code_invalid())
    }
}

/// End every session of an account but `keep`, and close their sockets.
pub(crate) async fn close_sessions(
    conn: &mut PgConnection,
    account_id: i64,
    keep: Option<i64>,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM sessions WHERE account_id = $1 AND id IS DISTINCT FROM $2")
        .bind(account_id)
        .bind(keep)
        .execute(&mut *conn)
        .await?;
    let closed = Event::SessionsClosed {
        account: account_id,
        keep,
    };
    events::publish(conn, &closed).await
}

async fn replace_backup_codes(conn: &mut PgConnection, account_id: i64) -> ApiResult<Vec<String>> {
    let codes: Vec<String> = (0..BACKUP_CODES).map(|_| new_backup_code()).collect();
    let mut hashes = Vec::with_capacity(codes.len());
    for code in &codes {
        hashes.push(hash_backup_code(code)?);
    }
    sqlx::query("DELETE FROM backup_codes WHERE account_id = $1")
        .bind(account_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "INSERT INTO backup_codes (account_id, code_hash)
         SELECT $1, hash FROM UNNEST($2::text[]) AS hash",
    )
    .bind(account_id)
    .bind(&hashes)
    .execute(conn)
    .await?;
    Ok(codes.iter().map(|code| display_backup_code(code)).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    totp: bool,
    /// Backup codes not yet used.
    backup_codes: i64,
    recovery_key: bool,
    /// Whether this device signed in with a second factor.
    session_verified: bool,
}

pub async fn status(State(state): State<AppState>, user: AuthUser) -> ApiResult<Msgpack<Status>> {
    let (totp, backup_codes, recovery_key, session_verified): (bool, i64, bool, bool) =
        sqlx::query_as(
            "SELECT EXISTS (SELECT 1 FROM second_factors f
                            WHERE f.account_id = a.id AND f.confirmed_at IS NOT NULL),
                    (SELECT count(*) FROM backup_codes b
                     WHERE b.account_id = a.id AND b.used_at IS NULL),
                    a.recovery_pubkey IS NOT NULL,
                    COALESCE((SELECT s.second_factor_at IS NOT NULL FROM sessions s
                              WHERE s.id = $2), false)
             FROM accounts a WHERE a.id = $1",
        )
        .bind(user.account_id)
        .bind(user.session_id)
        .fetch_one(&state.pool)
        .await?;
    Ok(Msgpack(Status {
        totp,
        backup_codes,
        recovery_key,
        session_verified,
    }))
}

#[derive(Serialize)]
pub struct Enrolment {
    /// The secret in the form an authenticator app takes when typed in.
    secret: String,
    /// The same secret as the link a QR code carries.
    url: String,
}

/// Start setting up an authenticator. Nothing changes for the account until
/// a code from it has been confirmed.
pub async fn enroll_totp(
    State(state): State<AppState>,
    _attempt: AuthAttempt,
    user: AuthUser,
    headers: HeaderMap,
    Msgpack(request): Msgpack<SignedRequest>,
) -> ApiResult<Msgpack<Enrolment>> {
    let mut tx = state.pool.begin().await?;
    let (account, body) =
        auth::verify_own(&state, &mut tx, &headers, &user, &request, "enrollTotp").await?;
    // Replacing an authenticator. A device that signed in with the old one
    // may do it on the password alone, which is the way back when the
    // authenticator and the backup codes are both gone. Any other caller
    // shows a code. With nothing enrolled yet there is no code to show.
    let verified: bool =
        sqlx::query_scalar("SELECT second_factor_at IS NOT NULL FROM sessions WHERE id = $1")
            .bind(user.session_id)
            .fetch_optional(&mut *tx)
            .await?
            .unwrap_or(false);
    if !verified {
        check_second_factor(&state, &mut tx, account.id, body.totp.as_deref()).await?;
    }

    let secret = random_bytes::<{ totp::SECRET_LEN }>();
    sqlx::query(
        "INSERT INTO second_factors (account_id, kind, secret) VALUES ($1, 'totp', $2)
         ON CONFLICT (account_id, kind) WHERE confirmed_at IS NULL
         DO UPDATE SET secret = EXCLUDED.secret, last_step = 0, created_at = now()",
    )
    .bind(account.id)
    .bind(state.vault.seal(&secret))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let url = totp::provisioning_url(&state.config.totp_issuer, &account.username, &secret)
        .map_err(ApiError::internal)?;
    Ok(Msgpack(Enrolment {
        secret: totp::base32(&secret),
        url,
    }))
}

#[derive(Deserialize)]
pub struct Code {
    code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCodes {
    backup_codes: Vec<String>,
}

/// Finish setting up an authenticator by showing a code from it. From here
/// on the account needs one to sign in.
pub async fn confirm_totp(
    State(state): State<AppState>,
    user: AuthUser,
    Msgpack(body): Msgpack<Code>,
) -> ApiResult<Msgpack<BackupCodes>> {
    let mut tx = state.pool.begin().await?;
    // Turning a second factor on ends the other sessions. A sign-in on the
    // password alone must not slip in behind that.
    auth::lock_account(&mut tx, user.account_id).await?;
    let pending: Option<(i64, Vec<u8>)> = sqlx::query_as(
        "SELECT id, secret FROM second_factors
         WHERE account_id = $1 AND kind = 'totp' AND confirmed_at IS NULL
           AND created_at > now() - interval '1 hour'
         FOR UPDATE",
    )
    .bind(user.account_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((factor_id, sealed)) = pending else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "totp_not_started",
            "Start setting up the authenticator first.",
        ));
    };
    if state.code_limiter.blocked(user.account_id) {
        return Err(throttled());
    }
    let secret = open_secret(&state, &sealed)?;
    let Some(step) = totp::verify(&secret, &normalise(&body.code), now_secs(), 0) else {
        state.code_limiter.failed(user.account_id);
        return Err(code_invalid());
    };

    // The old authenticator stops working the moment the new one is proven.
    sqlx::query(
        "DELETE FROM second_factors
         WHERE account_id = $1 AND kind = 'totp' AND confirmed_at IS NOT NULL",
    )
    .bind(user.account_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE second_factors SET confirmed_at = now(), last_step = $2 WHERE id = $1")
        .bind(factor_id)
        .bind(step as i64)
        .execute(&mut *tx)
        .await?;
    let backup_codes = replace_backup_codes(&mut tx, user.account_id).await?;
    sqlx::query("UPDATE sessions SET second_factor_at = now() WHERE id = $1")
        .bind(user.session_id)
        .execute(&mut *tx)
        .await?;
    // Every other device signs in again, this time with a code. One of them
    // may be the reason the authenticator was set up or replaced.
    close_sessions(&mut tx, user.account_id, Some(user.session_id)).await?;
    tx.commit().await?;
    Ok(Msgpack(BackupCodes { backup_codes }))
}

pub async fn disable_totp(
    State(state): State<AppState>,
    _attempt: AuthAttempt,
    user: AuthUser,
    headers: HeaderMap,
    Msgpack(request): Msgpack<SignedRequest>,
) -> ApiResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let (account, body) =
        auth::verify_own(&state, &mut tx, &headers, &user, &request, "disableTotp").await?;
    if !check_second_factor(&state, &mut tx, account.id, body.totp.as_deref()).await? {
        return Err(not_enrolled());
    }
    remove_second_factor(&mut tx, account.id).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Take the second factor off an account, along with everything that only
/// meant something while it had one.
pub(crate) async fn remove_second_factor(
    conn: &mut PgConnection,
    account_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM second_factors WHERE account_id = $1")
        .bind(account_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM backup_codes WHERE account_id = $1")
        .bind(account_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("UPDATE sessions SET second_factor_at = NULL WHERE account_id = $1")
        .bind(account_id)
        .execute(conn)
        .await?;
    Ok(())
}

/// Replace the backup codes with a fresh set. The old ones stop working.
pub async fn new_backup_codes(
    State(state): State<AppState>,
    _attempt: AuthAttempt,
    user: AuthUser,
    headers: HeaderMap,
    Msgpack(request): Msgpack<SignedRequest>,
) -> ApiResult<Msgpack<BackupCodes>> {
    let mut tx = state.pool.begin().await?;
    let (account, body) =
        auth::verify_own(&state, &mut tx, &headers, &user, &request, "newBackupCodes").await?;
    if !check_second_factor(&state, &mut tx, account.id, body.totp.as_deref()).await? {
        return Err(not_enrolled());
    }
    let backup_codes = replace_backup_codes(&mut tx, account.id).await?;
    tx.commit().await?;
    Ok(Msgpack(BackupCodes { backup_codes }))
}

/// Set or replace the recovery key: a second copy of the account's keys,
/// wrapped under a secret only the user holds, and the public key that
/// proves they hold it.
pub async fn set_recovery(
    State(state): State<AppState>,
    _attempt: AuthAttempt,
    user: AuthUser,
    headers: HeaderMap,
    Msgpack(request): Msgpack<SignedRequest>,
) -> ApiResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let (account, body) =
        auth::verify_own(&state, &mut tx, &headers, &user, &request, "setRecovery").await?;
    let (Some(pubkey), Some(content)) = (body.recovery_pubkey, body.recovery_encrypted_content)
    else {
        return Err(ApiError::bad_request("Missing the recovery key."));
    };
    auth::validate_recovery_key(&pubkey, &content)?;
    check_second_factor(&state, &mut tx, account.id, body.totp.as_deref()).await?;
    sqlx::query(
        "UPDATE accounts SET recovery_pubkey = $2, recovery_encrypted_content = $3 WHERE id = $1",
    )
    .bind(account.id)
    .bind(&pubkey[..])
    .bind(&content[..])
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    id: i64,
    /// What the device called itself when it signed in.
    device_name: String,
    /// Seconds since 1970.
    created_at: i64,
    /// Accurate to a few minutes: ordinary requests do not write to it.
    last_used_at: i64,
    second_factor: bool,
    /// The session asking.
    current: bool,
}

#[derive(Serialize)]
pub struct Sessions {
    sessions: Vec<SessionInfo>,
}

pub async fn list_sessions(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Msgpack<Sessions>> {
    let sessions = sqlx::query_as(
        "SELECT id, device_name,
                extract(epoch FROM created_at)::bigint AS created_at,
                extract(epoch FROM last_used_at)::bigint AS last_used_at,
                second_factor_at IS NOT NULL AS second_factor,
                id = $2 AS current
         FROM sessions WHERE account_id = $1
         ORDER BY last_used_at DESC, id DESC",
    )
    .bind(user.account_id)
    .bind(user.session_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Msgpack(Sessions { sessions }))
}

/// Sign one device out from another.
pub async fn revoke_session(
    State(state): State<AppState>,
    user: AuthUser,
    Path(session): Path<i64>,
) -> ApiResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let ended = sqlx::query("DELETE FROM sessions WHERE id = $1 AND account_id = $2")
        .bind(session)
        .bind(user.account_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if ended == 0 {
        return Err(ApiError::not_found("Session"));
    }
    events::publish(&mut tx, &Event::SessionClosed { session }).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn revoke_other_sessions(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    close_sessions(&mut tx, user.account_id, Some(user.session_id)).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryOpened {
    recovery_encrypted_content: ByteBuf,
    /// Shows, for a few minutes, that the recovery key and the second factor
    /// were accepted. A code works only once, so the request that sets the
    /// new password could not carry it again.
    grant: String,
}

/// First half of a reset: prove the recovery key, and the second factor if
/// there is one, and receive the copy of the account keys it unwraps.
pub async fn recover(
    State(state): State<AppState>,
    _attempt: AuthAttempt,
    headers: HeaderMap,
    Msgpack(request): Msgpack<SignedRequest>,
) -> ApiResult<Msgpack<RecoveryOpened>> {
    let mut tx = state.pool.begin().await?;
    let (account, body) = auth::verify_signed(
        &state,
        &mut tx,
        &headers,
        &request,
        "recover",
        SignedBy::RecoveryKey,
    )
    .await?;
    check_second_factor(&state, &mut tx, account.id, body.totp.as_deref()).await?;
    let content = account
        .recovery_encrypted_content
        .ok_or_else(|| ApiError::internal("an account has a recovery key and no recovery copy"))?;
    // The code is spent with the grant in hand, not before.
    tx.commit().await?;
    Ok(Msgpack(RecoveryOpened {
        recovery_encrypted_content: ByteBuf::from(content),
        grant: state.keys.recovery_grant(account.id),
    }))
}

/// Second half: the account keys wrapped under the new password, and a new
/// recovery key to replace the one just used. Every device is signed out and
/// the caller gets a fresh session.
pub async fn complete_recovery(
    State(state): State<AppState>,
    _attempt: AuthAttempt,
    headers: HeaderMap,
    Msgpack(request): Msgpack<SignedRequest>,
) -> ApiResult<Msgpack<LoginResponse>> {
    let mut tx = state.pool.begin().await?;
    let (mut account, body) = auth::verify_signed(
        &state,
        &mut tx,
        &headers,
        &request,
        "recoverComplete",
        SignedBy::RecoveryKey,
    )
    .await?;
    let granted = body
        .grant
        .as_deref()
        .and_then(|grant| state.keys.verify_recovery_grant(grant));
    if granted != Some(account.id) {
        return Err(ApiError::unauthorized(
            "recovery_expired",
            "This recovery took too long. Start it again.",
        ));
    }
    let (Some(login_pubkey), Some(encrypted_content)) = (body.login_pubkey, body.encrypted_content)
    else {
        return Err(ApiError::bad_request("Missing the new account keys."));
    };
    let (Some(recovery_pubkey), Some(recovery_content)) =
        (body.recovery_pubkey, body.recovery_encrypted_content)
    else {
        return Err(ApiError::bad_request("Missing the new recovery key."));
    };
    auth::validate_account_keys(&login_pubkey, &encrypted_content)?;
    auth::validate_recovery_key(&recovery_pubkey, &recovery_content)?;
    let used = account.recovery_pubkey.clone().unwrap_or_default();
    if recovery_pubkey[..] == used[..] {
        // The key was typed into a device to get here. It is spent.
        return Err(ApiError::bad_request(
            "A recovery key cannot be kept after it has been used.",
        ));
    }

    // Matching on the key that signed this makes the grant good for one
    // reset: a second request finds the key already replaced.
    let updated = sqlx::query(
        "UPDATE accounts
         SET login_pubkey = $2, encrypted_content = $3,
             recovery_pubkey = $4, recovery_encrypted_content = $5
         WHERE id = $1 AND recovery_pubkey = $6",
    )
    .bind(account.id)
    .bind(&login_pubkey[..])
    .bind(&encrypted_content[..])
    .bind(&recovery_pubkey[..])
    .bind(&recovery_content[..])
    .bind(&used[..])
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated != 1 {
        return Err(ApiError::conflict(
            "recovery_used",
            "This recovery key has already been used.",
        ));
    }
    close_sessions(&mut tx, account.id, None).await?;
    // The second factor was proven in the first half; the grant vouches for
    // it here.
    let second_factor = enrolled(&mut tx, account.id).await?;
    account.encrypted_content = encrypted_content.into_vec();
    let response = auth::open_session(&mut tx, account, &headers, second_factor).await?;
    tx.commit().await?;
    Ok(Msgpack(response))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrong_codes_lock_an_account_for_a_while_and_only_that_account() {
        let limiter = CodeLimiter::default();
        let start = Instant::now();
        for _ in 0..MAX_CODE_FAILURES - 1 {
            limiter.failed_at(1, start);
        }
        assert!(!limiter.blocked_at(1, start));
        limiter.failed_at(1, start + Duration::from_secs(60));
        assert!(limiter.blocked_at(1, start + Duration::from_secs(61)));
        assert!(!limiter.blocked_at(2, start + Duration::from_secs(61)));

        // The wait runs from the first wrong code, not the last.
        let later = start + CODE_FAILURE_WINDOW + Duration::from_secs(1);
        assert!(!limiter.blocked_at(1, later));
        limiter.failed_at(1, later);
        assert!(!limiter.blocked_at(1, later));
    }

    #[test]
    fn right_code_wipes_the_count() {
        let limiter = CodeLimiter::default();
        let start = Instant::now();
        for _ in 0..MAX_CODE_FAILURES {
            limiter.failed_at(1, start);
        }
        assert!(limiter.blocked_at(1, start));
        limiter.clear(1);
        assert!(!limiter.blocked_at(1, start));
    }

    #[test]
    fn codes_are_read_the_way_people_type_them() {
        assert_eq!(normalise(" 123 456 "), "123456");
        assert_eq!(normalise("abcde-fghij"), "ABCDEFGHIJ");
        assert!(looks_like_totp("123456"));
        assert!(!looks_like_totp("12345"));
        assert!(!looks_like_totp("ABCDEF"));
    }

    #[test]
    fn backup_codes_are_long_random_and_never_mistaken_for_a_totp_code() {
        let codes: Vec<String> = (0..200).map(|_| new_backup_code()).collect();
        for code in &codes {
            assert_eq!(code.len(), BACKUP_CODE_LEN);
            assert!(!looks_like_totp(code));
            let shown = display_backup_code(code);
            assert_eq!(shown.len(), BACKUP_CODE_LEN + 1);
            assert_eq!(&normalise(&shown.to_lowercase()), code);
        }
        let mut unique = codes.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), codes.len());
    }

    #[test]
    fn backup_code_hashes_verify_and_nothing_else_verifies() {
        let code = new_backup_code();
        let hash = hash_backup_code(&code).expect("hash a code");
        assert!(hash.starts_with("$argon2id$"));
        assert!(backup_code_matches(&hash, &code));
        assert!(!backup_code_matches(&hash, &new_backup_code()));
        assert!(!backup_code_matches("not a hash", &code));
        assert!(!backup_code_matches("", &code));
        // Every code gets its own salt: the same code hashes differently.
        let again = hash_backup_code(&code).expect("hash a code again");
        assert_ne!(hash, again);
        assert!(backup_code_matches(&again, &code));
    }
}
