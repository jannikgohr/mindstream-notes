//! Invite links, and the two ways into a server whose signup is not open.
//!
//! An invite link is an invitation addressed to whoever holds a secret. The
//! person sharing makes the secret up and derives two keys from it. The
//! collection key is encrypted to the first, the way an invitation encrypts
//! it to a user's key. The second signs, and its public half is stored here.
//! The link itself is this server's address, the link's uid and, after the
//! `#`, the secret. Browsers do not send that part and the server never sees
//! it.
//!
//! So the server can tell a caller holds the secret, by a signature, without
//! being able to open what the link carries. A uid alone gets nothing: uids
//! pass through address bars, logs and chat previews.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use sqlx::PgConnection;

use crate::auth::{username_key, AuthUser};
use crate::collections::{self, membership};
use crate::config::SignupPolicy;
use crate::edge::AuthAttempt;
use crate::error::{ApiError, ApiResult};
use crate::events::{self, Event};
use crate::keys::{hash_session_token, random_bytes};
use crate::limits;
use crate::sharing;
use crate::totp;
use crate::wire::{
    self, check_uid, msgpack_response, Msgpack, Signup, ACCESS_ADMIN, ACCESS_READ_ONLY,
    ACCESS_READ_WRITE,
};
use crate::AppState;

const MAX_KEY_BYTES: usize = 4096;
/// People one link may let in.
const MAX_USES: i32 = 100;
const DEFAULT_LIFETIME_SECS: i64 = 7 * 24 * 3600;
const MIN_LIFETIME_SECS: i64 = 60;
const MAX_LIFETIME_SECS: i64 = 90 * 24 * 3600;
/// Links one collection may have outstanding.
const MAX_LINKS_PER_COLLECTION: i64 = 50;
/// Characters in a signup code, five bits each.
const SIGNUP_CODE_LEN: usize = 20;

/// What a caller signs to show it holds a link's secret: what it asks for,
/// of which link, as whom. Naming the account keeps a signature lifted from
/// one request from serving another account.
fn proof_message(action: &str, link_uid: &str, username: &str) -> Vec<u8> {
    format!(
        "mindstream-link:{action}:{link_uid}:{}",
        username_key(username)
    )
    .into_bytes()
}

fn proves(claim_pubkey: &[u8], signature: &[u8], message: &[u8]) -> bool {
    let Ok(key) = <[u8; 32]>::try_from(claim_pubkey) else {
        return false;
    };
    let (Ok(key), Ok(signature)) = (
        VerifyingKey::from_bytes(&key),
        Signature::from_slice(signature),
    ) else {
        return false;
    };
    key.verify_strict(message, &signature).is_ok()
}

/// Also what a caller without the secret gets, so a uid cannot be probed.
fn no_link() -> ApiError {
    ApiError::not_found("Link")
}

fn gone(code: &'static str, detail: &str) -> ApiError {
    ApiError::new(StatusCode::GONE, code, detail)
}

#[derive(sqlx::FromRow)]
struct Link {
    id: i64,
    uid: String,
    version: i16,
    collection_id: i64,
    collection: String,
    owner_id: i64,
    access_level: i16,
    signed_encryption_key: Vec<u8>,
    claim_pubkey: Vec<u8>,
    max_uses: i32,
    uses: i32,
    allows_signup: bool,
    signups: i32,
    expired: bool,
    from_account_id: i64,
    from_username: String,
    from_pubkey: Vec<u8>,
}

impl Link {
    /// Whether anyone else may still join on this link. Joining takes the
    /// link's places, one per claim, so this is the membership budget.
    fn claimable(&self) -> ApiResult<()> {
        if self.expired {
            Err(gone("link_expired", "This link has expired."))
        } else if self.uses >= self.max_uses {
            Err(gone("link_used", "This link has been used up."))
        } else {
            Ok(())
        }
    }

    /// Whether the link may still bring someone without an account. A signup
    /// is only useful if the account it creates can then join, and every
    /// signup that never joins still costs the maker an account, so signups
    /// have their own budget beside the claims: neither may reach the
    /// maximum while the other has places left unused.
    fn signup_available(&self) -> bool {
        !self.expired && self.uses < self.max_uses && self.signups < self.max_uses
    }
}

/// Find a link that still stands. A link stops standing when whoever made it
/// stops being an admin of the collection: it was their authority it carried.
///
/// With `lock`, the collection and the link are locked until the transaction
/// ends, the collection first like every other writer. The link is read once
/// the collection is locked, so that a maker removed by whoever held the
/// lock is seen to be gone.
async fn find(conn: &mut PgConnection, uid: &str, lock: bool) -> ApiResult<Option<Link>> {
    if lock {
        let collection: Option<i64> =
            sqlx::query_scalar("SELECT collection_id FROM invite_links WHERE uid = $1")
                .bind(uid)
                .fetch_optional(&mut *conn)
                .await?;
        let Some(collection) = collection else {
            return Ok(None);
        };
        collections::lock_collection(&mut *conn, collection).await?;
    }
    Ok(sqlx::query_as(&format!(
        "SELECT l.id, l.uid, l.version, l.collection_id, c.uid AS collection, c.owner_id,
                l.access_level, l.signed_encryption_key, l.claim_pubkey, l.max_uses, l.uses,
                l.allows_signup, l.signups, l.expires_at <= now() AS expired,
                l.from_account_id, sender.username AS from_username,
                sender.pubkey AS from_pubkey
         FROM invite_links l
         JOIN collections c ON c.id = l.collection_id
         JOIN accounts sender ON sender.id = l.from_account_id AND NOT sender.disabled
         JOIN members m ON m.collection_id = c.id AND m.account_id = sender.id
                       AND m.access_level = {ACCESS_ADMIN}
         WHERE l.uid = $1 {}",
        if lock { "FOR UPDATE OF l" } else { "" }
    ))
    .bind(uid)
    .fetch_optional(conn)
    .await?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkCreate {
    uid: String,
    version: u8,
    collection: String,
    access_level: i16,
    signed_encryption_key: ByteBuf,
    claim_pubkey: ByteBuf,
    #[serde(default)]
    max_uses: Option<i32>,
    /// Seconds from now.
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    allow_signup: bool,
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct LinkInfo {
    uid: String,
    access_level: i16,
    max_uses: i32,
    uses: i32,
    allows_signup: bool,
    /// Seconds since 1970.
    expires_at: i64,
    created_at: i64,
    from_username: String,
}

const LINK_INFO: &str = "SELECT l.uid, l.access_level, l.max_uses, l.uses, l.allows_signup,
            extract(epoch FROM l.expires_at)::bigint AS expires_at,
            extract(epoch FROM l.created_at)::bigint AS created_at,
            sender.username AS from_username
     FROM invite_links l JOIN accounts sender ON sender.id = l.from_account_id";

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Msgpack(body): Msgpack<LinkCreate>,
) -> ApiResult<Response> {
    check_uid(&body.uid)?;
    // Whoever holds a link is a stranger until they use it. A stranger is
    // not handed the power to remove everyone else.
    if !matches!(body.access_level, ACCESS_READ_ONLY | ACCESS_READ_WRITE) {
        return Err(ApiError::bad_request(
            "A link can give read or write access, and nothing more.",
        ));
    }
    if body.signed_encryption_key.is_empty() || body.signed_encryption_key.len() > MAX_KEY_BYTES {
        return Err(ApiError::bad_request("Malformed invitation key."));
    }
    let claim_key = <[u8; 32]>::try_from(&body.claim_pubkey[..])
        .ok()
        .and_then(|key| VerifyingKey::from_bytes(&key).ok());
    if claim_key.is_none() {
        return Err(ApiError::bad_request("Malformed link key."));
    }
    let max_uses = body.max_uses.unwrap_or(1);
    if !(1..=MAX_USES).contains(&max_uses) {
        return Err(ApiError::bad_request(format!(
            "A link can let in between 1 and {MAX_USES} people."
        )));
    }
    let lifetime = body.expires_in.unwrap_or(DEFAULT_LIFETIME_SECS);
    if !(MIN_LIFETIME_SECS..=MAX_LIFETIME_SECS).contains(&lifetime) {
        return Err(ApiError::bad_request(
            "A link lasts between a minute and 90 days.",
        ));
    }
    if body.allow_signup && state.config.signup == SignupPolicy::Closed {
        return Err(ApiError::forbidden(
            "signup_closed",
            "This server does not let links create accounts.",
        ));
    }

    let mut tx = state.pool.begin().await?;
    let collection = membership(&mut tx, user.account_id, &body.collection, true).await?;
    collection.require_admin()?;
    collection.require_live()?;
    let expired: Vec<i64> = sqlx::query_scalar(
        "DELETE FROM invite_links WHERE collection_id = $1 AND expires_at <= now()
         RETURNING (octet_length(uid) + octet_length(signed_encryption_key)
                    + octet_length(claim_pubkey))::bigint",
    )
    .bind(collection.id)
    .fetch_all(&mut *tx)
    .await?;
    let expired_bytes: i64 = expired.iter().sum();
    if expired_bytes > 0 {
        sqlx::query(
            "UPDATE collections SET bytes_used = GREATEST(bytes_used - $2, 0) WHERE id = $1",
        )
        .bind(collection.id)
        .bind(expired_bytes)
        .execute(&mut *tx)
        .await?;
    }
    let outstanding: i64 =
        sqlx::query_scalar("SELECT count(*) FROM invite_links WHERE collection_id = $1")
            .bind(collection.id)
            .fetch_one(&mut *tx)
            .await?;
    if outstanding >= MAX_LINKS_PER_COLLECTION {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "too_many_links",
            "This space has too many links already. Remove some first.",
        ));
    }
    // A link nobody could use is refused now, while the person making it
    // can still do something about it.
    limits::check_new_member(&mut tx, collection.id, collection.owner_id, true).await?;
    let link_bytes = body.uid.len() as i64
        + body.signed_encryption_key.len() as i64
        + body.claim_pubkey.len() as i64;
    if let Some(limits) = limits::for_writes(&mut tx, collection.owner_id).await? {
        limits.check(link_bytes, 0, false)?;
    }

    let inserted = sqlx::query(
        "INSERT INTO invite_links
             (uid, version, collection_id, from_account_id, access_level,
              signed_encryption_key, claim_pubkey, max_uses, allows_signup, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10))
         ON CONFLICT (uid) DO NOTHING",
    )
    .bind(&body.uid)
    .bind(i16::from(body.version))
    .bind(collection.id)
    .bind(user.account_id)
    .bind(body.access_level)
    .bind(&body.signed_encryption_key[..])
    .bind(&body.claim_pubkey[..])
    .bind(max_uses)
    .bind(body.allow_signup)
    .bind(lifetime as f64)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if inserted == 0 {
        return Err(ApiError::conflict(
            "unique_uid",
            "Link with this uid already exists",
        ));
    }
    sqlx::query("UPDATE collections SET bytes_used = bytes_used + $2 WHERE id = $1")
        .bind(collection.id)
        .bind(link_bytes)
        .execute(&mut *tx)
        .await?;
    let info: LinkInfo = sqlx::query_as(&format!("{LINK_INFO} WHERE l.uid = $1"))
        .bind(&body.uid)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(msgpack_response(StatusCode::CREATED, &info))
}

#[derive(Deserialize)]
pub struct ListQuery {
    collection: String,
}

#[derive(Serialize)]
pub struct Links {
    links: Vec<LinkInfo>,
}

/// The links into a collection that could still let someone in, or have
/// until recently.
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<ListQuery>,
) -> ApiResult<Msgpack<Links>> {
    let mut conn = state.pool.acquire().await?;
    let collection = membership(&mut conn, user.account_id, &query.collection, false).await?;
    collection.require_admin()?;
    let links = sqlx::query_as(&format!(
        "{LINK_INFO} WHERE l.collection_id = $1 AND l.expires_at > now() ORDER BY l.id"
    ))
    .bind(collection.id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(Msgpack(Links { links }))
}

pub async fn revoke(
    State(state): State<AppState>,
    user: AuthUser,
    Path(uid): Path<String>,
) -> ApiResult<StatusCode> {
    // Any admin of the collection may, not only the one who made the link.
    let mut tx = state.pool.begin().await?;
    let removed: Option<(i64, i64)> = sqlx::query_as(&format!(
        "DELETE FROM invite_links l USING members m
         WHERE l.uid = $1 AND m.collection_id = l.collection_id AND m.account_id = $2
           AND m.access_level = {ACCESS_ADMIN}
         RETURNING l.collection_id,
                   (octet_length(l.uid) + octet_length(l.signed_encryption_key)
                    + octet_length(l.claim_pubkey))::bigint"
    ))
    .bind(&uid)
    .bind(user.account_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((collection, bytes)) = removed else {
        return Err(no_link());
    };
    if bytes > 0 {
        sqlx::query(
            "UPDATE collections SET bytes_used = GREATEST(bytes_used - $2, 0) WHERE id = $1",
        )
        .bind(collection)
        .bind(bytes)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct Proof {
    signature: ByteBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedLink {
    uid: String,
    version: i16,
    collection: String,
    access_level: i16,
    signed_encryption_key: ByteBuf,
    from_username: String,
    from_pubkey: ByteBuf,
    /// The collection's own item, whose metadata holds its name. The key
    /// inside the link opens it.
    collection_item: wire::Item,
    /// Whether the link lets its holder create an account here first.
    signup: bool,
}

/// Look at what a link leads to, before deciding to join or even having an
/// account. Takes the secret and nothing else.
pub async fn open(
    State(state): State<AppState>,
    _attempt: AuthAttempt,
    Path(uid): Path<String>,
    Msgpack(body): Msgpack<Proof>,
) -> ApiResult<Msgpack<OpenedLink>> {
    check_uid(&uid)?;
    let mut conn = state.pool.acquire().await?;
    let message = proof_message("open", &uid, "");
    let link = find(&mut conn, &uid, false)
        .await?
        .filter(|link| proves(&link.claim_pubkey, &body.signature, &message))
        .ok_or_else(no_link)?;
    link.claimable()?;
    let collection_item =
        collections::main_items(&state, &mut conn, &[link.collection_id], i64::MAX)
            .await?
            .remove(&link.collection_id)
            .ok_or_else(|| ApiError::internal("a collection has no main item"))?;
    Ok(Msgpack(OpenedLink {
        signup: state.config.signup == SignupPolicy::Invite
            && link.allows_signup
            && link.signup_available(),
        uid: link.uid,
        version: link.version,
        collection: link.collection,
        access_level: link.access_level,
        signed_encryption_key: ByteBuf::from(link.signed_encryption_key),
        from_username: link.from_username,
        from_pubkey: ByteBuf::from(link.from_pubkey),
        collection_item,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    signature: ByteBuf,
    collection_type: ByteBuf,
    encryption_key: ByteBuf,
}

/// Join the collection a link leads to. The membership and the count of the
/// link's uses change together or not at all.
pub async fn claim(
    State(state): State<AppState>,
    user: AuthUser,
    Path(uid): Path<String>,
    Msgpack(body): Msgpack<Claim>,
) -> ApiResult<StatusCode> {
    check_uid(&uid)?;
    sharing::validate_membership_keys(&body.encryption_key, &body.collection_type)?;
    let mut tx = state.pool.begin().await?;
    let username: String = sqlx::query_scalar("SELECT username FROM accounts WHERE id = $1")
        .bind(user.account_id)
        .fetch_one(&mut *tx)
        .await?;
    let message = proof_message("claim", &uid, &username);
    let link = find(&mut tx, &uid, true)
        .await?
        .filter(|link| proves(&link.claim_pubkey, &body.signature, &message))
        .ok_or_else(no_link)?;

    let already: Option<i16> = sqlx::query_scalar(
        "SELECT access_level FROM members WHERE collection_id = $1 AND account_id = $2",
    )
    .bind(link.collection_id)
    .bind(user.account_id)
    .fetch_optional(&mut *tx)
    .await?;
    if already.is_some() {
        // Nothing is used up. A link opened twice by the same person should
        // not cost someone else their place.
        return Err(ApiError::conflict(
            "already_member",
            "You already belong to this space.",
        ));
    }
    link.claimable()?;
    limits::check_new_member(&mut tx, link.collection_id, link.owner_id, false).await?;

    sharing::add_member(
        &mut tx,
        link.collection_id,
        link.owner_id,
        &user,
        link.access_level,
        &body.encryption_key,
        &body.collection_type,
    )
    .await?;
    sqlx::query("UPDATE invite_links SET uses = uses + 1 WHERE id = $1")
        .bind(link.id)
        .execute(&mut *tx)
        .await?;
    // Whoever made the link sees its count move.
    let used = Event::Invitation {
        account: link.from_account_id,
    };
    events::publish(&mut tx, &used).await?;
    tx.commit().await?;
    Ok(StatusCode::CREATED)
}

// ---------- signing up by invitation ----------

/// By what right an account is being created.
pub(crate) enum SignupGrant {
    /// Signup is open to anyone.
    Open,
    /// A code an administrator handed out.
    Code(i64),
    /// An invite link whose maker let it create accounts.
    Link(i64),
}

fn signup_closed() -> ApiError {
    ApiError::forbidden("signup_closed", "This server does not accept signups.")
}

fn invitation_invalid() -> ApiError {
    ApiError::forbidden(
        "signup_invitation_invalid",
        "This invitation to sign up is no longer valid.",
    )
}

/// A code as typed, without the spaces and dashes people add.
fn normalise_code(code: &str) -> String {
    code.chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

fn hash_code(code: &str) -> [u8; 32] {
    hash_session_token(&normalise_code(code))
}

/// A fresh signup code, grouped so it can be read out loud.
pub(crate) fn new_signup_code() -> String {
    let code = &totp::base32(&random_bytes::<13>())[..SIGNUP_CODE_LEN];
    code.as_bytes()
        .chunks(5)
        .map(|group| std::str::from_utf8(group).expect("base32 is ASCII"))
        .collect::<Vec<_>>()
        .join("-")
}

pub(crate) async fn store_signup_code(
    conn: &mut PgConnection,
    code: &str,
    note: &str,
    days: i32,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO signup_codes (code_hash, note, expires_at)
         VALUES ($1, $2, now() + make_interval(days => $3))",
    )
    .bind(&hash_code(code)[..])
    .bind(note)
    .bind(days)
    .execute(conn)
    .await?;
    Ok(())
}

/// Decide whether a signup may go ahead. What it finds stays locked until
/// the transaction ends, so two signups cannot both spend one invitation.
pub(crate) async fn signup_grant(
    state: &AppState,
    conn: &mut PgConnection,
    body: &Signup,
) -> ApiResult<SignupGrant> {
    if state.config.signup == SignupPolicy::Open {
        return Ok(SignupGrant::Open);
    }
    if let Some(code) = &body.signup_code {
        let id: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM signup_codes
             WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
             FOR UPDATE",
        )
        .bind(&hash_code(code)[..])
        .fetch_optional(conn)
        .await?;
        return id.map(SignupGrant::Code).ok_or_else(invitation_invalid);
    }
    if let (Some(proof), SignupPolicy::Invite) = (&body.link, state.config.signup) {
        check_uid(&proof.uid)?;
        let message = proof_message("signup", &proof.uid, &body.user.username);
        return find(conn, &proof.uid, true)
            .await?
            .filter(|link| {
                link.allows_signup
                    && link.signup_available()
                    && proves(&link.claim_pubkey, &proof.signature, &message)
            })
            .map(|link| SignupGrant::Link(link.id))
            .ok_or_else(invitation_invalid);
    }
    Err(signup_closed())
}

/// Spend what `signup_grant` found, once the account exists.
pub(crate) async fn redeem(
    conn: &mut PgConnection,
    grant: SignupGrant,
    account_id: i64,
) -> Result<(), sqlx::Error> {
    match grant {
        SignupGrant::Open => {}
        SignupGrant::Code(id) => {
            sqlx::query("UPDATE signup_codes SET used_by = $2, used_at = now() WHERE id = $1")
                .bind(id)
                .bind(account_id)
                .execute(conn)
                .await?;
        }
        SignupGrant::Link(id) => {
            sqlx::query("UPDATE invite_links SET signups = signups + 1 WHERE id = $1")
                .bind(id)
                .execute(conn)
                .await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signer, SigningKey};

    use super::*;

    #[test]
    fn proof_holds_for_one_action_link_and_account() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let public = key.verifying_key().to_bytes();
        let message = proof_message("claim", "link1", "Ann");
        let signature = key.sign(&message).to_bytes();
        assert!(proves(&public, &signature, &message));
        // Usernames compare without regard to case, here as everywhere.
        assert!(proves(
            &public,
            &signature,
            &proof_message("claim", "link1", "ann")
        ));

        for other in [
            proof_message("open", "link1", "ann"),
            proof_message("signup", "link1", "ann"),
            proof_message("claim", "link2", "ann"),
            proof_message("claim", "link1", "bob"),
        ] {
            assert!(!proves(&public, &signature, &other));
        }
        let stranger = SigningKey::from_bytes(&[8; 32]).verifying_key().to_bytes();
        assert!(!proves(&stranger, &signature, &message));
        assert!(!proves(&public[..31], &signature, &message));
        assert!(!proves(&public, &signature[..63], &message));
    }

    #[test]
    fn signup_code_is_read_the_way_it_is_typed() {
        let code = new_signup_code();
        assert_eq!(code.len(), SIGNUP_CODE_LEN + 3);
        assert_eq!(code.split('-').count(), 4);
        let typed = code.to_lowercase().replace('-', " ");
        assert_eq!(hash_code(&typed), hash_code(&code));
        assert_ne!(hash_code(&new_signup_code()), hash_code(&code));
    }
}
