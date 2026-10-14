//! Who belongs to a collection, and the invitations that get them there.
//!
//! An invitation carries the collection key encrypted to the recipient. The
//! server stores and delivers it without being able to open it; accepting
//! one turns it into a membership holding the key re-encrypted by the
//! recipient for themselves.
//!
//! Every membership change takes a number from the change counter and moves
//! the collection's cursor, so the members' devices see it on their next
//! sync.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_bytes::ByteBuf;
use sqlx::PgConnection;

use crate::auth::{username_key, AuthUser};
use crate::collections::{self, membership, next_changes, Membership};
use crate::error::{ApiError, ApiResult};
use crate::events::{self, Event};
use crate::limits;
use crate::wire::{
    check_uid, valid_access_level, FetchQuery, Invitation, InvitationAccept, InvitationCreate,
    IteratorList, Member, MemberPatch, Msgpack, UserProfile, ACCESS_ADMIN,
};
use crate::AppState;

const MAX_KEY_BYTES: usize = 4096;

async fn account_id_of(conn: &mut PgConnection, username: &str) -> ApiResult<i64> {
    sqlx::query_scalar("SELECT id FROM accounts WHERE username_key = $1 AND NOT disabled")
        .bind(username_key(username))
        .fetch_optional(conn)
        .await?
        .ok_or_else(|| ApiError::not_found("User"))
}

/// Record a membership change: give it a change number and move the
/// collection's cursor to it.
async fn touch_collection(conn: &mut PgConnection, collection_id: i64) -> ApiResult<i64> {
    let stoken = next_changes(conn, 1).await?;
    sqlx::query("UPDATE collections SET stoken = $2 WHERE id = $1")
        .bind(collection_id)
        .bind(stoken)
        .execute(conn)
        .await?;
    Ok(stoken)
}

// ---------- members ----------

pub async fn list_members(
    State(state): State<AppState>,
    user: AuthUser,
    Path(collection_uid): Path<String>,
    Query(query): Query<FetchQuery>,
) -> ApiResult<Msgpack<IteratorList<Member>>> {
    let limit = query.limit();
    // The iterator is the account id of the last member on the previous page.
    let after: i64 = match query.iterator.as_deref() {
        None => 0,
        Some(value) => value.parse().map_err(|_| {
            ApiError::new(StatusCode::BAD_REQUEST, "bad_iterator", "Invalid iterator.")
        })?,
    };
    let mut conn = state.pool.acquire().await?;
    let collection = membership(&mut conn, user.account_id, &collection_uid, false).await?;
    collection.require_admin()?;

    let mut rows: Vec<(i64, String, i16)> = sqlx::query_as(
        "SELECT m.account_id, a.username, m.access_level
         FROM members m JOIN accounts a ON a.id = m.account_id
         WHERE m.collection_id = $1 AND m.account_id > $2
         ORDER BY m.account_id LIMIT $3",
    )
    .bind(collection.id)
    .bind(after)
    .bind(limit + 1)
    .fetch_all(&mut *conn)
    .await?;
    let done = rows.len() as i64 <= limit;
    rows.truncate(limit as usize);
    Ok(Msgpack(IteratorList {
        iterator: rows.last().map(|row| row.0.to_string()),
        data: rows
            .into_iter()
            .map(|(_, username, access_level)| Member {
                username,
                access_level,
            })
            .collect(),
        done,
    }))
}

/// Take a membership away and leave a marker so the member's devices learn
/// of it. Returns whether there was a membership to remove.
async fn remove_membership(
    conn: &mut PgConnection,
    collection: &Membership,
    account_id: i64,
) -> ApiResult<bool> {
    let removed = sqlx::query("DELETE FROM members WHERE collection_id = $1 AND account_id = $2")
        .bind(collection.id)
        .bind(account_id)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    if removed == 0 {
        return Ok(false);
    }
    let stoken = touch_collection(conn, collection.id).await?;
    sqlx::query(
        "INSERT INTO removed_members (collection_id, account_id, stoken) VALUES ($1, $2, $3)
         ON CONFLICT (collection_id, account_id) DO UPDATE SET stoken = EXCLUDED.stoken",
    )
    .bind(collection.id)
    .bind(account_id)
    .bind(stoken)
    .execute(&mut *conn)
    .await?;
    withdraw_invitations(conn, collection.id, account_id).await?;
    // Their open sockets close, and the remaining members see the roster
    // change.
    let lost = Event::Membership {
        collection: collection.id,
        account: account_id,
        access: None,
    };
    events::publish(conn, &lost).await?;
    let changed = Event::Changed {
        collection: collection.id,
        session: None,
    };
    events::publish(conn, &changed).await?;
    Ok(true)
}

fn owner_stays() -> ApiError {
    ApiError::forbidden(
        "owner_membership_fixed",
        "The owner of a collection cannot be removed from it or have their access changed.",
    )
}

pub async fn remove_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((collection_uid, username)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let collection = membership(&mut tx, user.account_id, &collection_uid, true).await?;
    collection.require_admin()?;
    let target = account_id_of(&mut tx, &username).await?;
    if target == collection.owner_id {
        return Err(owner_stays());
    }
    if !remove_membership(&mut tx, &collection, target).await? {
        return Err(ApiError::not_found("Member"));
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn leave(
    State(state): State<AppState>,
    user: AuthUser,
    Path(collection_uid): Path<String>,
) -> ApiResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let collection = membership(&mut tx, user.account_id, &collection_uid, true).await?;
    if user.account_id == collection.owner_id {
        return Err(owner_stays());
    }
    remove_membership(&mut tx, &collection, user.account_id).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn modify_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((collection_uid, username)): Path<(String, String)>,
    Msgpack(body): Msgpack<MemberPatch>,
) -> ApiResult<StatusCode> {
    if !valid_access_level(body.access_level) {
        return Err(ApiError::bad_request("Unknown access level."));
    }
    let mut tx = state.pool.begin().await?;
    let collection = membership(&mut tx, user.account_id, &collection_uid, true).await?;
    collection.require_admin()?;
    let target = account_id_of(&mut tx, &username).await?;
    if target == collection.owner_id {
        return Err(owner_stays());
    }
    let is_member: Option<i16> = sqlx::query_scalar(
        "SELECT access_level FROM members WHERE collection_id = $1 AND account_id = $2",
    )
    .bind(collection.id)
    .bind(target)
    .fetch_optional(&mut *tx)
    .await?;
    if is_member.is_none() {
        return Err(ApiError::not_found("Member"));
    }
    let stoken = touch_collection(&mut tx, collection.id).await?;
    sqlx::query(
        "UPDATE members SET access_level = $3, stoken = $4
         WHERE collection_id = $1 AND account_id = $2",
    )
    .bind(collection.id)
    .bind(target)
    .bind(body.access_level)
    .bind(stoken)
    .execute(&mut *tx)
    .await?;
    if body.access_level != ACCESS_ADMIN {
        withdraw_invitations(&mut tx, collection.id, target).await?;
    }
    let access = Event::Membership {
        collection: collection.id,
        account: target,
        access: Some(body.access_level),
    };
    events::publish(&mut tx, &access).await?;
    let changed = Event::Changed {
        collection: collection.id,
        session: Some(user.session_id),
    };
    events::publish(&mut tx, &changed).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------- invitations ----------

/// The rule every invitation is read by: it stands only while whoever sent
/// it is an admin of the collection, on an account that is not disabled. It
/// was their authority the invitation carried. Invite links go by the same
/// rule, see `links::find`.
///
/// Reading by the rule is what keeps an invitation from outliving its
/// sender's authority. [`withdraw_invitations`] tidies up after it. The
/// result is a pair of joins on the invitation `i`.
fn sender_still_admin() -> String {
    format!(
        "JOIN accounts sender
             ON sender.id = i.from_account_id AND NOT sender.disabled
         JOIN members sender_member
             ON sender_member.collection_id = i.collection_id
            AND sender_member.account_id = sender.id
            AND sender_member.access_level = {ACCESS_ADMIN}"
    )
}

/// Delete the invitations an account sent into a collection it is no longer
/// an admin of, and tell the invited, whose lists just got shorter. The
/// caller holds the lock on the collection.
async fn withdraw_invitations(
    conn: &mut PgConnection,
    collection_id: i64,
    sender: i64,
) -> ApiResult<()> {
    let invited: Vec<i64> = sqlx::query_scalar(
        "DELETE FROM invitations WHERE collection_id = $1 AND from_account_id = $2
         RETURNING to_account_id",
    )
    .bind(collection_id)
    .bind(sender)
    .fetch_all(&mut *conn)
    .await?;
    for account in invited {
        events::publish(conn, &Event::Invitation { account }).await?;
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct ProfileQuery {
    username: String,
}

/// The public key to encrypt an invitation to. A client should remember the
/// key it first saw for a username and distrust a change: a server could
/// answer with a key of its own.
pub async fn fetch_user_profile(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(query): Query<ProfileQuery>,
) -> ApiResult<Msgpack<UserProfile>> {
    let pubkey: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT pubkey FROM accounts WHERE username_key = $1 AND NOT disabled")
            .bind(username_key(&query.username))
            .fetch_optional(&state.pool)
            .await?;
    Ok(Msgpack(UserProfile {
        pubkey: ByteBuf::from(pubkey.ok_or_else(|| ApiError::not_found("User"))?),
    }))
}

pub async fn invite(
    State(state): State<AppState>,
    user: AuthUser,
    Msgpack(body): Msgpack<InvitationCreate>,
) -> ApiResult<StatusCode> {
    check_uid(&body.uid)?;
    if !valid_access_level(body.access_level) {
        return Err(ApiError::bad_request("Unknown access level."));
    }
    if body.signed_encryption_key.is_empty() || body.signed_encryption_key.len() > MAX_KEY_BYTES {
        return Err(ApiError::bad_request("Malformed invitation key."));
    }
    let mut tx = state.pool.begin().await?;
    let collection = membership(&mut tx, user.account_id, &body.collection, false).await?;
    collection.require_admin()?;
    let recipient = account_id_of(&mut tx, &body.username).await?;
    if recipient == user.account_id {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "no_self_invite",
            "Inviting yourself is not allowed",
        ));
    }

    let exists = || {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invitation_exists",
            "Invitation already exists",
        )
    };
    let already_member: Option<i16> = sqlx::query_scalar(
        "SELECT access_level FROM members WHERE collection_id = $1 AND account_id = $2",
    )
    .bind(collection.id)
    .bind(recipient)
    .fetch_optional(&mut *tx)
    .await?;
    if already_member.is_some() {
        return Err(exists());
    }
    // An invitation that could never be accepted is refused now, while the
    // person sending it can still do something about it.
    limits::check_new_member(&mut tx, collection.id, collection.owner_id, true).await?;
    let inserted = sqlx::query(
        "INSERT INTO invitations
             (uid, version, collection_id, from_account_id, to_account_id, access_level,
              signed_encryption_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING",
    )
    .bind(&body.uid)
    .bind(i16::from(body.version))
    .bind(collection.id)
    .bind(user.account_id)
    .bind(recipient)
    .bind(body.access_level)
    .bind(&body.signed_encryption_key[..])
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if inserted == 0 {
        return Err(exists());
    }
    events::publish(&mut tx, &Event::Invitation { account: recipient }).await?;
    tx.commit().await?;
    Ok(StatusCode::CREATED)
}

/// Invitations that stand, see [`sender_still_admin`]. Ends in a join, so a
/// `WHERE` follows it.
fn invitation_query() -> String {
    let sender_still_admin = sender_still_admin();
    format!(
        "SELECT i.uid, i.version, i.access_level, i.collection_id,
                recipient.username AS username, c.uid AS collection, i.signed_encryption_key,
                sender.username AS from_username, sender.pubkey AS from_pubkey
         FROM invitations i
         JOIN collections c ON c.id = i.collection_id
         {sender_still_admin}
         JOIN accounts recipient ON recipient.id = i.to_account_id"
    )
}

#[derive(sqlx::FromRow)]
struct InvitationRow {
    uid: String,
    version: i16,
    access_level: i16,
    collection_id: i64,
    username: String,
    collection: String,
    signed_encryption_key: Vec<u8>,
    from_username: String,
    from_pubkey: Vec<u8>,
}

impl From<InvitationRow> for Invitation {
    fn from(row: InvitationRow) -> Self {
        Self {
            uid: row.uid,
            version: row.version,
            access_level: row.access_level,
            username: row.username,
            collection: row.collection,
            signed_encryption_key: ByteBuf::from(row.signed_encryption_key),
            from_username: row.from_username,
            from_pubkey: ByteBuf::from(row.from_pubkey),
            collection_item: None,
        }
    }
}

/// Turn received invitations into what goes on the wire, each with its
/// collection's own item so the invited can see what they are invited to.
async fn with_previews(
    state: &AppState,
    conn: &mut PgConnection,
    rows: Vec<InvitationRow>,
) -> ApiResult<Vec<Invitation>> {
    let ids: Vec<i64> = rows.iter().map(|row| row.collection_id).collect();
    // One account holds at most one invitation to a collection, so each
    // item is wanted once.
    let mut items = collections::main_items(state, conn, &ids).await?;
    Ok(rows
        .into_iter()
        .map(|row| Invitation {
            collection_item: items.remove(&row.collection_id),
            ..row.into()
        })
        .collect())
}

#[derive(Clone, Copy)]
enum Direction {
    Incoming,
    Outgoing,
}

impl Direction {
    /// The column that must hold the caller's account.
    fn column(self) -> &'static str {
        match self {
            Direction::Incoming => "i.to_account_id",
            Direction::Outgoing => "i.from_account_id",
        }
    }
}

async fn list_invitations(
    state: &AppState,
    user: &AuthUser,
    query: &FetchQuery,
    direction: Direction,
) -> ApiResult<IteratorList<Invitation>> {
    let limit = query.limit();
    let column = direction.column();
    let mut conn = state.pool.acquire().await?;
    // The iterator is the uid of the last invitation on the previous page.
    let after: i64 = match query.iterator.as_deref() {
        None => 0,
        Some(uid) => sqlx::query_scalar(&format!(
            "SELECT i.id FROM invitations i WHERE i.uid = $1 AND {column} = $2"
        ))
        .bind(uid)
        .bind(user.account_id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| {
            ApiError::new(StatusCode::BAD_REQUEST, "bad_iterator", "Invalid iterator.")
        })?,
    };
    let mut rows: Vec<InvitationRow> = sqlx::query_as(&format!(
        "{} WHERE {column} = $1 AND i.id > $2 ORDER BY i.id LIMIT $3",
        invitation_query()
    ))
    .bind(user.account_id)
    .bind(after)
    .bind(limit + 1)
    .fetch_all(&mut *conn)
    .await?;
    let done = rows.len() as i64 <= limit;
    rows.truncate(limit as usize);
    Ok(IteratorList {
        iterator: rows.last().map(|row| row.uid.clone()),
        data: match direction {
            Direction::Incoming => with_previews(state, &mut conn, rows).await?,
            // The sender is a member and has the collection already.
            Direction::Outgoing => rows.into_iter().map(Invitation::from).collect(),
        },
        done,
    })
}

pub async fn list_incoming(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<FetchQuery>,
) -> ApiResult<Msgpack<IteratorList<Invitation>>> {
    Ok(Msgpack(
        list_invitations(&state, &user, &query, Direction::Incoming).await?,
    ))
}

pub async fn list_outgoing(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<FetchQuery>,
) -> ApiResult<Msgpack<IteratorList<Invitation>>> {
    Ok(Msgpack(
        list_invitations(&state, &user, &query, Direction::Outgoing).await?,
    ))
}

pub async fn fetch_incoming(
    State(state): State<AppState>,
    user: AuthUser,
    Path(uid): Path<String>,
) -> ApiResult<Msgpack<Invitation>> {
    let mut conn = state.pool.acquire().await?;
    let row: Option<InvitationRow> = sqlx::query_as(&format!(
        "{} WHERE i.to_account_id = $1 AND i.uid = $2",
        invitation_query()
    ))
    .bind(user.account_id)
    .bind(&uid)
    .fetch_optional(&mut *conn)
    .await?;
    let row = row.ok_or_else(|| ApiError::not_found("Invitation"))?;
    let mut invitations = with_previews(&state, &mut conn, vec![row]).await?;
    Ok(Msgpack(invitations.remove(0)))
}

async fn delete_invitation(
    state: &AppState,
    user: &AuthUser,
    uid: &str,
    direction: Direction,
) -> ApiResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let deleted: Option<(i64, i64)> = sqlx::query_as(&format!(
        "DELETE FROM invitations i WHERE i.uid = $1 AND {} = $2
         RETURNING i.from_account_id, i.to_account_id",
        direction.column()
    ))
    .bind(uid)
    .bind(user.account_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (sender, recipient) = deleted.ok_or_else(|| ApiError::not_found("Invitation"))?;
    // Both ends have a list this invitation just left.
    events::publish(&mut tx, &Event::Invitation { account: sender }).await?;
    events::publish(&mut tx, &Event::Invitation { account: recipient }).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn reject(
    State(state): State<AppState>,
    user: AuthUser,
    Path(uid): Path<String>,
) -> ApiResult<StatusCode> {
    delete_invitation(&state, &user, &uid, Direction::Incoming).await
}

pub async fn disinvite(
    State(state): State<AppState>,
    user: AuthUser,
    Path(uid): Path<String>,
) -> ApiResult<StatusCode> {
    delete_invitation(&state, &user, &uid, Direction::Outgoing).await
}

pub(crate) fn validate_membership_keys(
    encryption_key: &[u8],
    collection_type: &[u8],
) -> ApiResult<()> {
    if encryption_key.is_empty()
        || encryption_key.len() > MAX_KEY_BYTES
        || collection_type.len() > MAX_KEY_BYTES
    {
        return Err(ApiError::bad_request("Malformed membership key."));
    }
    Ok(())
}

/// Make an account a member of a collection: store its copy of the
/// collection key, move the collection's cursor and tell the open sockets.
/// The caller holds the lock on the collection.
pub(crate) async fn add_member(
    conn: &mut PgConnection,
    collection_id: i64,
    user: &AuthUser,
    access_level: i16,
    encryption_key: &[u8],
    collection_type: &[u8],
) -> ApiResult<()> {
    let stoken = touch_collection(conn, collection_id).await?;
    sqlx::query(
        "INSERT INTO members
             (collection_id, account_id, access_level, encryption_key, collection_type, stoken)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (collection_id, account_id) DO UPDATE
             SET access_level = EXCLUDED.access_level,
                 encryption_key = EXCLUDED.encryption_key,
                 collection_type = EXCLUDED.collection_type,
                 stoken = EXCLUDED.stoken",
    )
    .bind(collection_id)
    .bind(user.account_id)
    .bind(access_level)
    .bind(encryption_key)
    .bind(collection_type)
    .bind(stoken)
    .execute(&mut *conn)
    .await?;
    // Back in, so there is no lost membership left to report.
    sqlx::query("DELETE FROM removed_members WHERE collection_id = $1 AND account_id = $2")
        .bind(collection_id)
        .bind(user.account_id)
        .execute(&mut *conn)
        .await?;
    let joined = Event::Membership {
        collection: collection_id,
        account: user.account_id,
        access: Some(access_level),
    };
    events::publish(conn, &joined).await?;
    let changed = Event::Changed {
        collection: collection_id,
        session: Some(user.session_id),
    };
    events::publish(conn, &changed).await?;
    Ok(())
}

pub async fn accept(
    State(state): State<AppState>,
    user: AuthUser,
    Path(uid): Path<String>,
    Msgpack(body): Msgpack<InvitationAccept>,
) -> ApiResult<StatusCode> {
    validate_membership_keys(&body.encryption_key, &body.collection_type)?;
    let mut tx = state.pool.begin().await?;
    let no_invitation = || ApiError::not_found("Invitation");
    // Lock the collection before anything else, like every other writer.
    // Removing or downgrading the sender takes the same lock, so whether the
    // invitation still stands is settled before it is acted on. It is read
    // again once the lock is held, in a statement of its own: one that waits
    // for the lock goes on with the other rows as they were when it started.
    let collection_id: i64 = sqlx::query_scalar(
        "SELECT collection_id FROM invitations WHERE uid = $1 AND to_account_id = $2",
    )
    .bind(&uid)
    .bind(user.account_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(no_invitation)?;
    collections::lock_collection(&mut tx, collection_id).await?;
    // The invitation is locked too, so withdrawing it waits for this.
    let sender_still_admin = sender_still_admin();
    let invitation: Option<(i64, i16, i64, i64)> = sqlx::query_as(&format!(
        "SELECT i.id, i.access_level, i.from_account_id, c.owner_id
         FROM invitations i JOIN collections c ON c.id = i.collection_id
         {sender_still_admin}
         WHERE i.uid = $1 AND i.to_account_id = $2 AND i.collection_id = $3
         FOR UPDATE OF i"
    ))
    .bind(&uid)
    .bind(user.account_id)
    .bind(collection_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (invitation_id, access_level, sender, owner) = invitation.ok_or_else(no_invitation)?;
    limits::check_new_member(&mut tx, collection_id, owner, false).await?;

    add_member(
        &mut tx,
        collection_id,
        &user,
        access_level,
        &body.encryption_key,
        &body.collection_type,
    )
    .await?;
    sqlx::query("DELETE FROM invitations WHERE id = $1")
        .bind(invitation_id)
        .execute(&mut *tx)
        .await?;
    events::publish(&mut tx, &Event::Invitation { account: sender }).await?;
    tx.commit().await?;
    Ok(StatusCode::CREATED)
}
