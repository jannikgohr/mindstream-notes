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
use crate::collections::{self, give_back, membership, next_changes, Membership};
use crate::edge::ResponseRoom;
use crate::error::{ApiError, ApiResult};
use crate::events::{self, Event};
use crate::limits;
use crate::wire::{
    check_uid, valid_access_level, FetchQuery, Invitation, InvitationAccept, InvitationCreate,
    IteratorList, Member, MemberPatch, Msgpack, UserProfile, ACCESS_ADMIN,
};
use crate::AppState;

pub(crate) const MAX_KEY_BYTES: usize = 4096;

async fn account_id_of(conn: &mut PgConnection, username: &str) -> ApiResult<Option<i64>> {
    Ok(
        sqlx::query_scalar("SELECT id FROM accounts WHERE username_key = $1 AND NOT disabled")
            .bind(username_key(username))
            .fetch_optional(conn)
            .await?,
    )
}

/// The member of a collection with this name. Unlike [`account_id_of`] this
/// finds a disabled account: an admin has to be able to take one out, or the
/// links it made would come back with it. And it says nothing about a name
/// that is not a member here, whether or not an account has it.
async fn member_id_of(
    conn: &mut PgConnection,
    collection_id: i64,
    username: &str,
) -> ApiResult<i64> {
    sqlx::query_scalar(
        "SELECT a.id FROM accounts a
         JOIN members m ON m.account_id = a.id
         WHERE a.username_key = $1 AND m.collection_id = $2",
    )
    .bind(username_key(username))
    .bind(collection_id)
    .fetch_optional(conn)
    .await?
    .ok_or_else(|| ApiError::not_found("Member"))
}

/// Hold an account to a rate of naming other accounts, and to how many of
/// the names may turn out to be nobody's. Each such request says whether a
/// name exists, which is how a client finds who to invite and also how a list
/// of everyone could be had. The app asks once for each person the user
/// names, so it does not come near either. Past the second every name is
/// refused alike, or the refusals would go on telling them apart.
fn count_lookup(state: &AppState, user: &AuthUser) -> ApiResult<()> {
    if !state.unknown_names.blocked(user.account_id)
        && state.lookup_limiter.allow_key(&user.account_id)
    {
        return Ok(());
    }
    Err(ApiError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "throttled",
        "Too many names looked up. Try again later.",
    ))
}

/// What looking a name up found. Finding nothing counts, see [`count_lookup`].
fn looked_up<T>(state: &AppState, user: &AuthUser, found: Option<T>) -> ApiResult<T> {
    found.ok_or_else(|| {
        state.unknown_names.failed(user.account_id);
        ApiError::not_found("User")
    })
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
/// of it. `by_admin` says someone else took them out, which keeps them from
/// walking back in by a link, see `links::claim`.
async fn remove_membership(
    conn: &mut PgConnection,
    collection: &Membership,
    account_id: i64,
    by_admin: bool,
) -> ApiResult<()> {
    let removed: Option<i64> = sqlx::query_scalar(
        "DELETE FROM members WHERE collection_id = $1 AND account_id = $2
         RETURNING (octet_length(encryption_key) + octet_length(collection_type))::bigint",
    )
    .bind(collection.id)
    .bind(account_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(removed_bytes) = removed else {
        return Ok(());
    };
    give_back(conn, collection.id, removed_bytes).await?;
    let stoken = touch_collection(conn, collection.id).await?;
    sqlx::query(
        "INSERT INTO removed_members (collection_id, account_id, stoken, by_admin)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (collection_id, account_id)
             DO UPDATE SET stoken = EXCLUDED.stoken, by_admin = EXCLUDED.by_admin",
    )
    .bind(collection.id)
    .bind(account_id)
    .bind(stoken)
    .bind(by_admin)
    .execute(&mut *conn)
    .await?;
    withdraw_invitations(conn, collection.id, account_id, Direction::Outgoing).await?;
    withdraw_invitations(conn, collection.id, account_id, Direction::Incoming).await?;
    withdraw_links(conn, collection.id, account_id).await?;
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
    Ok(())
}

/// The collection was deleted, which for a shared folder is how its owner
/// stops sharing it. Everyone else is taken out as a removed member is, so
/// their devices hear of it and the server stops serving them, and every
/// way in that is still open is withdrawn. The caller holds the lock on the
/// collection.
pub(crate) async fn end_share(conn: &mut PgConnection, collection: &Membership) -> ApiResult<()> {
    let others: Vec<i64> = sqlx::query_scalar(
        "SELECT account_id FROM members WHERE collection_id = $1 AND account_id <> $2",
    )
    .bind(collection.id)
    .bind(collection.owner_id)
    .fetch_all(&mut *conn)
    .await?;
    for account in others {
        remove_membership(conn, collection, account, false).await?;
    }
    let withdrawn: Vec<(i64, i64)> = sqlx::query_as(
        "DELETE FROM invitations WHERE collection_id = $1
         RETURNING from_account_id, to_account_id",
    )
    .bind(collection.id)
    .fetch_all(&mut *conn)
    .await?;
    for (sender, recipient) in withdrawn {
        events::publish(conn, &Event::Invitation { account: sender }).await?;
        events::publish(conn, &Event::Invitation { account: recipient }).await?;
    }
    sqlx::query("DELETE FROM invite_links WHERE collection_id = $1")
        .bind(collection.id)
        .execute(conn)
        .await?;
    Ok(())
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
    let target = member_id_of(&mut tx, collection.id, &username).await?;
    if target == collection.owner_id {
        return Err(owner_stays());
    }
    // An admin taking themselves out is leaving like anyone else.
    let by_admin = target != user.account_id;
    remove_membership(&mut tx, &collection, target, by_admin).await?;
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
    remove_membership(&mut tx, &collection, user.account_id, false).await?;
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
    let target = member_id_of(&mut tx, collection.id, &username).await?;
    if target == collection.owner_id {
        return Err(owner_stays());
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
        withdraw_invitations(&mut tx, collection.id, target, Direction::Outgoing).await?;
        withdraw_links(&mut tx, collection.id, target).await?;
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

/// Delete the invitations an account is on one side of in a collection, and
/// tell the account on the other side, whose lists just got shorter. With
/// `Outgoing` the account sent them, and it is no longer an admin of the
/// collection. With `Incoming` the account holds them, because it is joining
/// or has just gone. An invitation is only a way in for someone outside, so
/// left standing it would outlive the membership and be a way back after a
/// removal. The caller holds the lock on the collection.
async fn withdraw_invitations(
    conn: &mut PgConnection,
    collection_id: i64,
    account_id: i64,
    direction: Direction,
) -> ApiResult<()> {
    let withdrawn: Vec<(i64, i64)> = sqlx::query_as(&format!(
        "DELETE FROM invitations i WHERE i.collection_id = $1 AND {column} = $2
         RETURNING {counterpart},
                   (octet_length(i.uid) + octet_length(i.signed_encryption_key))::bigint",
        column = direction.column(),
        counterpart = direction.counterpart_column(),
    ))
    .bind(collection_id)
    .bind(account_id)
    .fetch_all(&mut *conn)
    .await?;
    let bytes = withdrawn.iter().map(|(_, bytes)| bytes).sum();
    give_back(conn, collection_id, bytes).await?;
    for (account, _) in withdrawn {
        events::publish(conn, &Event::Invitation { account }).await?;
    }
    Ok(())
}

/// Delete the invite links an account made into a collection it is no longer
/// an admin of. A link carries the authority of whoever made it, so once that
/// authority is gone the link must go with it; otherwise removing or demoting
/// the maker would only pause the link, and re-adding or promoting them would
/// make it work again. The caller holds the lock on the collection.
async fn withdraw_links(conn: &mut PgConnection, collection_id: i64, sender: i64) -> ApiResult<()> {
    let bytes: Vec<i64> = sqlx::query_scalar(
        "DELETE FROM invite_links WHERE collection_id = $1 AND from_account_id = $2
         RETURNING (octet_length(uid) + octet_length(signed_encryption_key)
                    + octet_length(claim_pubkey))::bigint",
    )
    .bind(collection_id)
    .bind(sender)
    .fetch_all(&mut *conn)
    .await?;
    give_back(conn, collection_id, bytes.into_iter().sum()).await
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
    user: AuthUser,
    Query(query): Query<ProfileQuery>,
) -> ApiResult<Msgpack<UserProfile>> {
    count_lookup(&state, &user)?;
    let pubkey: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT pubkey FROM accounts WHERE username_key = $1 AND NOT disabled")
            .bind(username_key(&query.username))
            .fetch_optional(&state.pool)
            .await?;
    Ok(Msgpack(UserProfile {
        pubkey: ByteBuf::from(looked_up(&state, &user, pubkey)?),
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
    // Locked, so a deletion of the collection, which withdraws everything
    // still pending, is either done and seen here or waits for this.
    let collection = membership(&mut tx, user.account_id, &body.collection, true).await?;
    collection.require_admin()?;
    collection.require_live()?;
    count_lookup(&state, &user)?;
    let found = account_id_of(&mut tx, &body.username).await?;
    let recipient = looked_up(&state, &user, found)?;
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
    let invitation_bytes = body.uid.len() as i64 + body.signed_encryption_key.len() as i64;
    if let Some(limits) = limits::for_writes(&mut tx, collection.owner_id).await? {
        limits.check(invitation_bytes, 0, false)?;
    }
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
    sqlx::query("UPDATE collections SET bytes_used = bytes_used + $2 WHERE id = $1")
        .bind(collection.id)
        .bind(invitation_bytes)
        .execute(&mut *tx)
        .await?;
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
    room: &ResponseRoom,
    conn: &mut PgConnection,
    rows: Vec<InvitationRow>,
) -> ApiResult<Vec<Invitation>> {
    let ids: Vec<i64> = rows.iter().map(|row| row.collection_id).collect();
    // One account holds at most one invitation to a collection, so each
    // item is wanted once.
    let mut items =
        collections::main_items(state, room, conn, &ids, state.config.max_page_bytes).await?;
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

    /// The column that holds the other account on the invitation.
    fn counterpart_column(self) -> &'static str {
        match self {
            Direction::Incoming => "i.from_account_id",
            Direction::Outgoing => "i.to_account_id",
        }
    }
}

async fn list_invitations(
    state: &AppState,
    room: &ResponseRoom,
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
            Direction::Incoming => with_previews(state, room, &mut conn, rows).await?,
            // The sender is a member and has the collection already.
            Direction::Outgoing => rows.into_iter().map(Invitation::from).collect(),
        },
        done,
    })
}

pub async fn list_incoming(
    State(state): State<AppState>,
    room: ResponseRoom,
    user: AuthUser,
    Query(query): Query<FetchQuery>,
) -> ApiResult<Msgpack<IteratorList<Invitation>>> {
    Ok(Msgpack(
        list_invitations(&state, &room, &user, &query, Direction::Incoming).await?,
    ))
}

pub async fn list_outgoing(
    State(state): State<AppState>,
    room: ResponseRoom,
    user: AuthUser,
    Query(query): Query<FetchQuery>,
) -> ApiResult<Msgpack<IteratorList<Invitation>>> {
    Ok(Msgpack(
        list_invitations(&state, &room, &user, &query, Direction::Outgoing).await?,
    ))
}

pub async fn fetch_incoming(
    State(state): State<AppState>,
    room: ResponseRoom,
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
    let mut invitations = with_previews(&state, &room, &mut conn, vec![row]).await?;
    Ok(Msgpack(invitations.remove(0)))
}

async fn delete_invitation(
    state: &AppState,
    user: &AuthUser,
    uid: &str,
    direction: Direction,
) -> ApiResult<StatusCode> {
    let column = direction.column();
    let no_invitation = || ApiError::not_found("Invitation");
    let mut tx = state.pool.begin().await?;
    // The collection first, like every other writer. Taking the invitation
    // first and the collection's row for its bytes after would be the
    // opposite order to `accept`, and each could wait for the other.
    let collection: i64 = sqlx::query_scalar(&format!(
        "SELECT i.collection_id FROM invitations i WHERE i.uid = $1 AND {column} = $2"
    ))
    .bind(uid)
    .bind(user.account_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(no_invitation)?;
    collections::lock_collection(&mut tx, collection).await?;
    let deleted: Option<(i64, i64, i64)> = sqlx::query_as(&format!(
        "DELETE FROM invitations i WHERE i.uid = $1 AND {column} = $2
         RETURNING i.from_account_id, i.to_account_id,
                   (octet_length(i.uid) + octet_length(i.signed_encryption_key))::bigint"
    ))
    .bind(uid)
    .bind(user.account_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (sender, recipient, bytes) = deleted.ok_or_else(no_invitation)?;
    give_back(&mut tx, collection, bytes).await?;
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
    owner_id: i64,
    user: &AuthUser,
    access_level: i16,
    encryption_key: &[u8],
    collection_type: &[u8],
) -> ApiResult<()> {
    // An invitation to this account is no longer a way in once it joins.
    // Withdraw it first, so the space it used is part of what the new
    // membership has to fit.
    withdraw_invitations(conn, collection_id, user.account_id, Direction::Incoming).await?;
    let old_bytes: Option<(i32, i32)> = sqlx::query_as(
        "SELECT octet_length(encryption_key), octet_length(collection_type)
         FROM members WHERE collection_id = $1 AND account_id = $2",
    )
    .bind(collection_id)
    .bind(user.account_id)
    .fetch_optional(&mut *conn)
    .await?;
    let old_bytes = old_bytes.map_or(0i64, |(key, kind)| i64::from(key) + i64::from(kind));
    let new_bytes = encryption_key.len() as i64 + collection_type.len() as i64;
    if let Some(limits) = limits::for_writes(conn, owner_id).await? {
        limits.check((new_bytes - old_bytes).max(0), 0, false)?;
    }
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
    let delta = new_bytes - old_bytes;
    if delta != 0 {
        sqlx::query(
            "UPDATE collections SET bytes_used = GREATEST(bytes_used + $2, 0) WHERE id = $1",
        )
        .bind(collection_id)
        .bind(delta)
        .execute(&mut *conn)
        .await?;
    }
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
    // An invitation is only a way in for someone outside. Joining withdraws
    // them, so a member should hold none, but accepting one would overwrite
    // the access that member has now, and this is the one place that could
    // raise it. Withdraw it instead, so the row cannot be replayed later.
    let already_member: Option<i16> = sqlx::query_scalar(
        "SELECT access_level FROM members WHERE collection_id = $1 AND account_id = $2",
    )
    .bind(collection_id)
    .bind(user.account_id)
    .fetch_optional(&mut *tx)
    .await?;
    if already_member.is_some() {
        withdraw_invitations(&mut tx, collection_id, user.account_id, Direction::Incoming).await?;
        tx.commit().await?;
        return Err(ApiError::conflict(
            "already_member",
            "You are already a member of this collection.",
        ));
    }
    limits::check_new_member(&mut tx, collection_id, owner, false).await?;

    add_member(
        &mut tx,
        collection_id,
        owner,
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
