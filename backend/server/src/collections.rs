//! Collections, their items, revisions and chunks.
//!
//! An item is a list of revisions, and a revision is encrypted metadata plus
//! an ordered list of chunks. A collection is itself an item, the "main" one,
//! whose uid the collection shares.
//!
//! Every change takes a number from the global change counter. A cursor (the
//! client calls it a stoken) is such a number, and "what changed since this
//! cursor" is every row with a higher one.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde_bytes::ByteBuf;
use sqlx::PgConnection;

use crate::auth::AuthUser;
use crate::blob::Uncommitted;
use crate::chunks;
use crate::error::{ApiError, ApiResult, FieldError};
use crate::events::{self, Event};
use crate::limits;
use crate::wire::{
    self, check_uid, valid_uid, CollectionCreate, CollectionList, FetchQuery, ItemBatch, ItemList,
    ItemRef, IteratorList, ListMulti, Msgpack, RemovedCollection, ACCESS_ADMIN, ACCESS_READ_ONLY,
};
use crate::AppState;

const MAX_META_BYTES: usize = 64 * 1024;
const MAX_ITEMS_PER_REQUEST: usize = 10_000;
/// Chunks one revision may refer to. The client's chunker produces pieces
/// of some tens of kilobytes, so this is content in the gigabytes.
const MAX_CHUNKS_PER_REVISION: usize = 32_768;
/// The most metadata a revision may carry and still count as a deletion.
const MAX_TOMBSTONE_META_BYTES: usize = 16 * 1024;

const ITEM_COLUMNS: &str = "i.uid, i.version, i.encryption_key, i.stoken, \
     r.uid AS rev_uid, r.meta, r.deleted, r.chunk_ids";
const ITEM_TABLES: &str = "items i JOIN revisions r ON r.item_id = i.id AND r.uid = i.revision_uid";

/// A collection as seen by one of its members.
pub(crate) struct Membership {
    pub id: i64,
    pub uid: String,
    pub owner_id: i64,
    pub stoken: i64,
    pub access_level: i16,
}

impl Membership {
    pub fn require_write(&self) -> ApiResult<()> {
        if self.access_level == ACCESS_READ_ONLY {
            Err(ApiError::no_write_access())
        } else {
            Ok(())
        }
    }

    pub fn require_admin(&self) -> ApiResult<()> {
        if self.access_level == ACCESS_ADMIN {
            Ok(())
        } else {
            Err(ApiError::admin_required())
        }
    }
}

/// The single place a request is tied to a collection. Every handler that
/// touches one goes through here, so a non-member can never reach a
/// collection's rows: to them it does not exist.
///
/// With `lock`, the collection row is locked until the transaction ends,
/// which serialises writers to one collection, and the membership is read
/// once the lock is held.
pub(crate) async fn membership(
    conn: &mut PgConnection,
    account_id: i64,
    collection_uid: &str,
    lock: bool,
) -> ApiResult<Membership> {
    check_uid(collection_uid)?;
    if lock {
        let id: Option<i64> =
            sqlx::query_scalar("SELECT id FROM collections WHERE uid = $1 FOR UPDATE")
                .bind(collection_uid)
                .fetch_optional(&mut *conn)
                .await?;
        if id.is_none() {
            return Err(ApiError::not_found("Collection"));
        }
    }
    // Never in the statement that locks. One that waits for the lock goes on
    // with the other rows as they were when it started, so a membership
    // taken away by whoever held the lock would still let this through.
    let row: Option<(i64, i64, i64, i16)> = sqlx::query_as(
        "SELECT c.id, c.owner_id, c.stoken, m.access_level
         FROM collections c
         JOIN members m ON m.collection_id = c.id AND m.account_id = $2
         WHERE c.uid = $1",
    )
    .bind(collection_uid)
    .bind(account_id)
    .fetch_optional(conn)
    .await?;
    let (id, owner_id, stoken, access_level) =
        row.ok_or_else(|| ApiError::not_found("Collection"))?;
    Ok(Membership {
        id,
        uid: collection_uid.to_owned(),
        owner_id,
        stoken,
        access_level,
    })
}

/// Lock a collection's row until the transaction ends, the way every writer
/// to it starts. For callers that reach the collection by something other
/// than a membership; whatever decides that the write may go ahead must be
/// read after this, in statements of its own.
pub(crate) async fn lock_collection(conn: &mut PgConnection, collection_id: i64) -> ApiResult<()> {
    sqlx::query("SELECT 1 FROM collections WHERE id = $1 FOR UPDATE")
        .bind(collection_id)
        .execute(conn)
        .await?;
    Ok(())
}

/// Take `count` consecutive numbers from the change counter and return the
/// first. The row lock this takes is held until the transaction commits, so
/// call it as late as possible: it is what orders commits across the server.
pub(crate) async fn next_changes(conn: &mut PgConnection, count: i64) -> ApiResult<i64> {
    let last: i64 =
        sqlx::query_scalar("UPDATE change_counter SET value = value + $1 RETURNING value")
            .bind(count)
            .fetch_one(conn)
            .await?;
    Ok(last - count + 1)
}

fn bad_stoken() -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "bad_stoken", "Invalid stoken.")
}

/// The cursor a list starts after. No cursor means the beginning.
fn list_cursor(state: &AppState, stoken: Option<&str>) -> ApiResult<i64> {
    match stoken {
        None => Ok(0),
        Some(token) => state.keys.parse_stoken(token).ok_or_else(bad_stoken),
    }
}

#[derive(sqlx::FromRow)]
struct ItemRow {
    uid: String,
    version: i16,
    encryption_key: Option<Vec<u8>>,
    stoken: i64,
    rev_uid: String,
    meta: Vec<u8>,
    deleted: bool,
    chunk_ids: Vec<i64>,
}

#[derive(sqlx::FromRow)]
struct CollectionRow {
    col_stoken: i64,
    access_level: i16,
    member_key: Vec<u8>,
    collection_type: Vec<u8>,
    #[sqlx(flatten)]
    item: ItemRow,
}

fn to_wire_revision(
    uid: String,
    meta: Vec<u8>,
    deleted: bool,
    chunk_ids: &[i64],
    loaded: &mut chunks::Loaded,
) -> ApiResult<wire::Revision> {
    Ok(wire::Revision {
        uid,
        meta: ByteBuf::from(meta),
        deleted,
        chunks: loaded.revision(chunk_ids)?,
    })
}

fn to_wire_item(row: ItemRow, loaded: &mut chunks::Loaded) -> ApiResult<wire::Item> {
    Ok(wire::Item {
        uid: row.uid,
        version: row.version as u8,
        encryption_key: row.encryption_key.map(ByteBuf::from),
        content: to_wire_revision(row.rev_uid, row.meta, row.deleted, &row.chunk_ids, loaded)?,
        etag: None,
    })
}

/// Read what a response needs of these items' chunks, in the order the
/// items will go out. Content is held to the page budget, see
/// [`chunks::Loaded`].
async fn load_chunks(
    state: &AppState,
    conn: &mut PgConnection,
    rows: &[ItemRow],
    with_content: bool,
) -> ApiResult<chunks::Loaded> {
    let revisions: Vec<&[i64]> = rows.iter().map(|row| row.chunk_ids.as_slice()).collect();
    chunks::load(
        conn,
        &state.blobs,
        &revisions,
        with_content,
        state.config.max_page_bytes,
    )
    .await
}

async fn to_wire_items(
    state: &AppState,
    conn: &mut PgConnection,
    rows: Vec<ItemRow>,
    with_content: bool,
) -> ApiResult<Vec<wire::Item>> {
    let mut loaded = load_chunks(state, conn, &rows, with_content).await?;
    rows.into_iter()
        .map(|row| to_wire_item(row, &mut loaded))
        .collect()
}

/// The main item of each of these collections, without its content. It is
/// what someone invited needs to read a collection's name before joining.
pub(crate) async fn main_items(
    state: &AppState,
    conn: &mut PgConnection,
    collection_ids: &[i64],
) -> ApiResult<HashMap<i64, wire::Item>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        collection_id: i64,
        #[sqlx(flatten)]
        item: ItemRow,
    }
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "SELECT i.collection_id, {ITEM_COLUMNS} FROM {ITEM_TABLES}
         WHERE i.collection_id = ANY($1) AND i.is_main"
    ))
    .bind(collection_ids)
    .fetch_all(&mut *conn)
    .await?;
    let revisions: Vec<&[i64]> = rows
        .iter()
        .map(|row| row.item.chunk_ids.as_slice())
        .collect();
    let mut loaded = chunks::load(conn, &state.blobs, &revisions, false, 0).await?;
    rows.into_iter()
        .map(|row| Ok((row.collection_id, to_wire_item(row.item, &mut loaded)?)))
        .collect()
}

// ---------- collections ----------

const COLLECTION_QUERY: &str = "SELECT c.stoken AS col_stoken, m.access_level, \
            m.encryption_key AS member_key, m.collection_type, \
            i.uid, i.version, i.encryption_key, i.stoken, \
            r.uid AS rev_uid, r.meta, r.deleted, r.chunk_ids \
     FROM members m \
     JOIN collections c ON c.id = m.collection_id \
     JOIN items i ON i.collection_id = c.id AND i.is_main \
     JOIN revisions r ON r.item_id = i.id AND r.uid = i.revision_uid";

async fn to_wire_collections(
    state: &AppState,
    conn: &mut PgConnection,
    rows: Vec<CollectionRow>,
    with_content: bool,
) -> ApiResult<Vec<wire::Collection>> {
    let revisions: Vec<&[i64]> = rows
        .iter()
        .map(|row| row.item.chunk_ids.as_slice())
        .collect();
    let mut loaded = chunks::load(
        conn,
        &state.blobs,
        &revisions,
        with_content,
        state.config.max_page_bytes,
    )
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(wire::Collection {
                access_level: row.access_level,
                collection_key: ByteBuf::from(row.member_key),
                collection_type: ByteBuf::from(row.collection_type),
                stoken: state.keys.stoken(row.col_stoken),
                item: to_wire_item(row.item, &mut loaded)?,
            })
        })
        .collect()
}

/// A read-only transaction whose statements all see the database as it was
/// when the first of them ran.
///
/// A cursor is only safe to hand out if every change up to it is in the
/// answer it comes with. Two statements on a plain connection each see what
/// had committed by the time they ran, so the second can see a change, and
/// move the cursor past it, that the first ran too early to include. The
/// client would then never be told of what committed in between.
pub(crate) async fn snapshot(
    pool: &sqlx::PgPool,
) -> Result<sqlx::Transaction<'static, sqlx::Postgres>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}

/// The collections the account belongs to that changed after the cursor,
/// optionally only those of the given types, plus the ones it lost access to.
async fn list_collections(
    state: &AppState,
    user: &AuthUser,
    query: &FetchQuery,
    types: Option<Vec<Vec<u8>>>,
) -> ApiResult<CollectionList> {
    let since = list_cursor(state, query.stoken.as_deref())?;
    let limit = query.limit();
    // The changed collections and the lost memberships are two statements
    // that feed one cursor, so they read from one snapshot.
    let mut conn = snapshot(&state.pool).await?;

    let mut rows: Vec<CollectionRow> = sqlx::query_as(&format!(
        "{COLLECTION_QUERY}
         WHERE m.account_id = $1 AND c.stoken > $2
           AND ($3::bytea[] IS NULL OR m.collection_type = ANY($3))
         ORDER BY c.stoken LIMIT $4"
    ))
    .bind(user.account_id)
    .bind(since)
    .bind(&types)
    .bind(limit + 1)
    .fetch_all(&mut *conn)
    .await?;
    let done = rows.len() as i64 <= limit;
    rows.truncate(limit as usize);
    let mut cursor = rows.last().map(|row| row.col_stoken);

    // Lost memberships only mean something relative to a cursor: a client
    // starting from scratch has nothing to forget.
    let mut removed = Vec::new();
    if query.stoken.is_some() {
        let lost: Vec<(String, i64)> = sqlx::query_as(
            "SELECT c.uid, r.stoken FROM removed_members r
             JOIN collections c ON c.id = r.collection_id
             WHERE r.account_id = $1 AND r.stoken > $2",
        )
        .bind(user.account_id)
        .bind(since)
        .fetch_all(&mut *conn)
        .await?;
        for (uid, stoken) in lost {
            // Only once the last page is out may the cursor move past them,
            // or a client that stops paging early would never hear of them.
            if done {
                cursor = Some(cursor.map_or(stoken, |c| c.max(stoken)));
            }
            removed.push(RemovedCollection { uid });
        }
    }

    Ok(CollectionList {
        data: to_wire_collections(state, &mut conn, rows, query.with_content()).await?,
        stoken: cursor
            .map(|seq| state.keys.stoken(seq))
            .or_else(|| query.stoken.clone()),
        done,
        removed_memberships: (!removed.is_empty()).then_some(removed),
    })
}

pub async fn list_multi(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<FetchQuery>,
    Msgpack(body): Msgpack<ListMulti>,
) -> ApiResult<Msgpack<CollectionList>> {
    let types = body
        .collection_types
        .into_iter()
        .map(ByteBuf::into_vec)
        .collect();
    Ok(Msgpack(
        list_collections(&state, &user, &query, Some(types)).await?,
    ))
}

pub async fn list_all(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<FetchQuery>,
) -> ApiResult<Msgpack<CollectionList>> {
    Ok(Msgpack(
        list_collections(&state, &user, &query, None).await?,
    ))
}

pub async fn fetch_collection(
    State(state): State<AppState>,
    user: AuthUser,
    Path(collection_uid): Path<String>,
    Query(query): Query<FetchQuery>,
) -> ApiResult<Msgpack<wire::Collection>> {
    check_uid(&collection_uid)?;
    let mut conn = state.pool.acquire().await?;
    let row: Option<CollectionRow> = sqlx::query_as(&format!(
        "{COLLECTION_QUERY} WHERE m.account_id = $1 AND c.uid = $2"
    ))
    .bind(user.account_id)
    .bind(&collection_uid)
    .fetch_optional(&mut *conn)
    .await?;
    let row = row.ok_or_else(|| ApiError::not_found("Collection"))?;
    let mut collections =
        to_wire_collections(&state, &mut conn, vec![row], query.with_content()).await?;
    Ok(Msgpack(collections.remove(0)))
}

pub async fn create_collection(
    State(state): State<AppState>,
    user: AuthUser,
    Msgpack(body): Msgpack<CollectionCreate>,
) -> ApiResult<StatusCode> {
    validate_items(std::slice::from_ref(&body.item))?;
    let collection_uid = body.item.uid.clone();

    let mut tx = state.pool.begin().await?;
    limits::check_new_space(&mut tx, user.account_id).await?;
    let id: Option<i64> = sqlx::query_scalar(
        "INSERT INTO collections (uid, owner_id, stoken) VALUES ($1, $2, 0)
         ON CONFLICT (uid) DO NOTHING RETURNING id",
    )
    .bind(&collection_uid)
    .bind(user.account_id)
    .fetch_optional(&mut *tx)
    .await?;
    let id = id.ok_or_else(|| {
        ApiError::conflict("unique_uid", "Collection with this uid already exists")
    })?;
    let collection = Membership {
        id,
        uid: collection_uid,
        owner_id: user.account_id,
        stoken: 0,
        access_level: ACCESS_ADMIN,
    };

    let stored = store_revisions(
        &state,
        &mut tx,
        &collection,
        user.account_id,
        vec![body.item],
        &HashMap::new(),
    )
    .await?;
    let stoken = stored
        .stoken
        .ok_or_else(|| ApiError::internal("a new collection stored no revision"))?;
    sqlx::query(
        "INSERT INTO members
             (collection_id, account_id, access_level, encryption_key, collection_type, stoken)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(collection.id)
    .bind(user.account_id)
    .bind(ACCESS_ADMIN)
    .bind(&body.collection_key[..])
    .bind(&body.collection_type[..])
    .bind(stoken)
    .execute(&mut *tx)
    .await?;
    // The account's other devices pick the new collection up at once.
    let event = Event::Changed {
        collection: collection.id,
        session: Some(user.session_id),
    };
    events::publish(&mut tx, &event).await?;
    stored.written.keep();
    tx.commit().await?;
    Ok(StatusCode::CREATED)
}

// ---------- reading items ----------

pub async fn list_items(
    State(state): State<AppState>,
    user: AuthUser,
    Path(collection_uid): Path<String>,
    Query(query): Query<FetchQuery>,
) -> ApiResult<Msgpack<ItemList>> {
    let since = list_cursor(&state, query.stoken.as_deref())?;
    let limit = query.limit();
    let mut conn = state.pool.acquire().await?;
    let collection = membership(&mut conn, user.account_id, &collection_uid, false).await?;

    let mut rows: Vec<ItemRow> = sqlx::query_as(&format!(
        "SELECT {ITEM_COLUMNS} FROM {ITEM_TABLES}
         WHERE i.collection_id = $1 AND i.stoken > $2 AND ($3 OR NOT i.is_main)
         ORDER BY i.stoken LIMIT $4"
    ))
    .bind(collection.id)
    .bind(since)
    .bind(query.with_collection())
    .bind(limit + 1)
    .fetch_all(&mut *conn)
    .await?;
    let mut done = rows.len() as i64 <= limit;
    rows.truncate(limit as usize);
    let mut loaded = load_chunks(&state, &mut conn, &rows, query.with_content()).await?;
    if query.with_content() {
        // The page ends early when its content would outgrow the budget.
        // To the client that is a short page like any other. An item too
        // large for any page goes out alone, as the uids of its chunks, so
        // the list cannot get stuck on it.
        let fits = loaded.fitting().max(1);
        if fits < rows.len() {
            rows.truncate(fits);
            done = false;
        }
    }
    let stoken = rows
        .last()
        .map(|row| state.keys.stoken(row.stoken))
        .or_else(|| query.stoken.clone());

    Ok(Msgpack(ItemList {
        data: rows
            .into_iter()
            .map(|row| to_wire_item(row, &mut loaded))
            .collect::<ApiResult<Vec<_>>>()?,
        stoken,
        done,
    }))
}

pub async fn fetch_item(
    State(state): State<AppState>,
    user: AuthUser,
    Path((collection_uid, item_uid)): Path<(String, String)>,
    Query(query): Query<FetchQuery>,
) -> ApiResult<Msgpack<wire::Item>> {
    check_uid(&item_uid)?;
    let mut conn = state.pool.acquire().await?;
    let collection = membership(&mut conn, user.account_id, &collection_uid, false).await?;
    let row: Option<ItemRow> = sqlx::query_as(&format!(
        "SELECT {ITEM_COLUMNS} FROM {ITEM_TABLES} WHERE i.collection_id = $1 AND i.uid = $2"
    ))
    .bind(collection.id)
    .bind(&item_uid)
    .fetch_optional(&mut *conn)
    .await?;
    let row = row.ok_or_else(|| ApiError::not_found("Item"))?;
    let mut items = to_wire_items(&state, &mut conn, vec![row], query.with_content()).await?;
    Ok(Msgpack(items.remove(0)))
}

/// Of the items the client names, return the ones it does not have the
/// latest revision of. With a cursor, that means changed after the cursor;
/// otherwise it means the etag it sent differs, and an item sent without an
/// etag always comes back.
pub async fn fetch_updates(
    State(state): State<AppState>,
    user: AuthUser,
    Path(collection_uid): Path<String>,
    Query(query): Query<FetchQuery>,
    Msgpack(refs): Msgpack<Vec<ItemRef>>,
) -> ApiResult<Msgpack<ItemList>> {
    if refs.len() > MAX_ITEMS_PER_REQUEST {
        return Err(ApiError::bad_request("Too many items in one request."));
    }
    let since = list_cursor(&state, query.stoken.as_deref())?;
    let mut conn = state.pool.acquire().await?;
    let collection = membership(&mut conn, user.account_id, &collection_uid, false).await?;

    let uids: Vec<&str> = refs.iter().map(|item| item.uid.as_str()).collect();
    let mut rows: Vec<ItemRow> = sqlx::query_as(&format!(
        "SELECT {ITEM_COLUMNS} FROM {ITEM_TABLES}
         WHERE i.collection_id = $1 AND i.uid = ANY($2) AND i.stoken > $3
         ORDER BY i.stoken"
    ))
    .bind(collection.id)
    .bind(&uids)
    .bind(since)
    .fetch_all(&mut *conn)
    .await?;
    let known: HashMap<&str, &str> = refs
        .iter()
        .filter_map(|item| Some((item.uid.as_str(), item.etag.as_deref()?)))
        .collect();
    rows.retain(|row| known.get(row.uid.as_str()) != Some(&row.rev_uid.as_str()));

    let stoken = rows
        .last()
        .map(|row| state.keys.stoken(row.stoken))
        .or_else(|| query.stoken.clone());
    Ok(Msgpack(ItemList {
        data: to_wire_items(&state, &mut conn, rows, query.with_content()).await?,
        stoken,
        done: true,
    }))
}

/// An item's history, newest first. The iterator is the uid of a revision;
/// the page starts after it.
pub async fn list_revisions(
    State(state): State<AppState>,
    user: AuthUser,
    Path((collection_uid, item_uid)): Path<(String, String)>,
    Query(query): Query<FetchQuery>,
) -> ApiResult<Msgpack<IteratorList<wire::Revision>>> {
    check_uid(&item_uid)?;
    let limit = query.limit();
    let mut conn = state.pool.acquire().await?;
    let collection = membership(&mut conn, user.account_id, &collection_uid, false).await?;
    let item_id: Option<i64> =
        sqlx::query_scalar("SELECT id FROM items WHERE collection_id = $1 AND uid = $2")
            .bind(collection.id)
            .bind(&item_uid)
            .fetch_optional(&mut *conn)
            .await?;
    let item_id = item_id.ok_or_else(|| ApiError::not_found("Item"))?;

    let before: Option<i64> = match query.iterator.as_deref() {
        None => None,
        Some(uid) => Some(
            sqlx::query_scalar("SELECT id FROM revisions WHERE item_id = $1 AND uid = $2")
                .bind(item_id)
                .bind(uid)
                .fetch_optional(&mut *conn)
                .await?
                .ok_or_else(|| {
                    ApiError::new(StatusCode::BAD_REQUEST, "bad_iterator", "Invalid iterator.")
                })?,
        ),
    };
    let mut rows: Vec<(String, Vec<u8>, bool, Vec<i64>)> = sqlx::query_as(
        "SELECT uid, meta, deleted, chunk_ids FROM revisions
         WHERE item_id = $1 AND ($2::bigint IS NULL OR id < $2)
         ORDER BY id DESC LIMIT $3",
    )
    .bind(item_id)
    .bind(before)
    .bind(limit + 1)
    .fetch_all(&mut *conn)
    .await?;
    let done = rows.len() as i64 <= limit;
    rows.truncate(limit as usize);

    let revisions: Vec<&[i64]> = rows.iter().map(|row| row.3.as_slice()).collect();
    let mut loaded = chunks::load(
        &mut conn,
        &state.blobs,
        &revisions,
        query.with_content(),
        state.config.max_page_bytes,
    )
    .await?;
    let iterator = rows.last().map(|row| row.0.clone());
    let data = rows
        .into_iter()
        .map(|(uid, meta, deleted, chunk_ids)| {
            to_wire_revision(uid, meta, deleted, &chunk_ids, &mut loaded)
        })
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(Msgpack(IteratorList {
        data,
        iterator,
        done,
    }))
}

// ---------- writing items ----------

fn validate_items(items: &[wire::Item]) -> ApiResult<()> {
    if items.len() > MAX_ITEMS_PER_REQUEST {
        return Err(ApiError::bad_request("Too many items in one request."));
    }
    let mut seen = HashSet::with_capacity(items.len());
    for item in items {
        if !valid_uid(&item.uid) || !valid_uid(&item.content.uid) {
            return Err(ApiError::bad_request("Malformed uid"));
        }
        if !seen.insert(item.uid.as_str()) {
            return Err(ApiError::bad_request(
                "The same item appears twice in one request.",
            ));
        }
        if item.content.meta.len() > MAX_META_BYTES {
            return Err(ApiError::bad_request("Item metadata is too large."));
        }
        if item.content.chunks.len() > MAX_CHUNKS_PER_REVISION {
            return Err(ApiError::bad_request("Item has too many chunks."));
        }
        // The client lists each chunk once and says in a header chunk where
        // it repeats. A revision naming one chunk many times is a few bytes
        // to send and as much as it likes to send back.
        let mut chunks_seen = HashSet::with_capacity(item.content.chunks.len());
        for chunk in &item.content.chunks {
            if !valid_uid(&chunk.0) {
                return Err(ApiError::bad_request("Malformed uid"));
            }
            if !chunks_seen.insert(chunk.0.as_str()) {
                return Err(ApiError::bad_request(
                    "The same chunk appears twice in one item.",
                ));
            }
            if chunk
                .1
                .as_ref()
                .is_some_and(|c| c.len() > chunks::MAX_CHUNK_BYTES)
            {
                return Err(ApiError::bad_request("Chunk is too large."));
            }
        }
    }
    Ok(())
}

pub(crate) struct ExistingItem {
    id: i64,
    revision_uid: String,
}

/// Whether a revision is a deletion in the sense the limits let through
/// whatever the plan says: it marks an item that is already there as
/// deleted and brings nothing to store but a little metadata.
///
/// The `deleted` flag alone is the client's word. A new item, or one that
/// arrives with content, is a write like any other whatever it calls
/// itself.
fn is_tombstone(item: &wire::Item, existing: &HashMap<String, ExistingItem>) -> bool {
    item.content.deleted
        && existing.contains_key(&item.uid)
        && item.content.meta.len() <= MAX_TOMBSTONE_META_BYTES
        && item.content.chunks.iter().all(|chunk| chunk.1.is_none())
}

/// What a write left behind for its caller to see to.
pub(crate) struct Stored {
    /// The collection's new cursor, or `None` when nothing changed.
    pub stoken: Option<i64>,
    /// Blobs no row points into any more. They can go once the transaction
    /// has committed, and not before: until then the rows may come back.
    pub freed_blobs: Vec<String>,
    /// Blobs the write added. Kept by calling `keep` just before the
    /// commit; dropped, they go.
    pub written: Uncommitted,
}

/// Delete the revisions of these items that are no longer kept, then the
/// chunks nothing refers to any more. Returns the bytes this gives back and
/// the blobs it leaves without rows.
///
/// What is kept: an item's current revision, and the `keep` revisions
/// before it. A deleted item keeps its tombstone and nothing else, which is
/// what makes deleting the way to get storage back.
///
/// The caller holds the collection's row lock, so no other write to the
/// collection can start referring to a chunk while this decides it is free.
async fn prune(
    conn: &mut PgConnection,
    collection_id: i64,
    item_ids: &[i64],
    keep: i64,
) -> ApiResult<(i64, Vec<String>)> {
    let dropped: Vec<(Vec<i64>, i64)> = sqlx::query_as(
        "DELETE FROM revisions r USING (
             SELECT old.id,
                    row_number() OVER (PARTITION BY old.item_id ORDER BY old.id DESC) AS age,
                    cur.deleted AS item_deleted
             FROM revisions old
             JOIN items i ON i.id = old.item_id
             JOIN revisions cur ON cur.item_id = i.id AND cur.uid = i.revision_uid
             WHERE old.item_id = ANY($1) AND old.uid <> i.revision_uid
         ) past
         WHERE r.id = past.id AND (past.item_deleted OR past.age > $2)
         RETURNING r.chunk_ids, octet_length(r.meta)::bigint",
    )
    .bind(item_ids)
    .bind(keep)
    .fetch_all(&mut *conn)
    .await?;
    if dropped.is_empty() {
        return Ok((0, Vec::new()));
    }
    let mut bytes: i64 = dropped.iter().map(|(_, meta)| *meta).sum();
    let candidates: Vec<i64> = dropped
        .into_iter()
        .flat_map(|(chunk_ids, _)| chunk_ids)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if candidates.is_empty() {
        return Ok((bytes, Vec::new()));
    }

    // Identical chunks are stored once per collection, so a chunk a dropped
    // revision used may still be in use by another item.
    let freed: Vec<(i32, Option<String>)> = sqlx::query_as(
        "DELETE FROM chunks c
         WHERE c.id = ANY($1) AND c.collection_id = $2
           AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.chunk_ids @> ARRAY[c.id])
         RETURNING c.size, c.blob_key",
    )
    .bind(&candidates)
    .bind(collection_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut blobs: Vec<String> = Vec::new();
    for (size, blob) in freed {
        bytes += i64::from(size);
        blobs.extend(blob);
    }
    blobs.sort_unstable();
    blobs.dedup();
    if blobs.is_empty() {
        return Ok((bytes, blobs));
    }
    // A blob holds the chunks of one upload. It goes when the last of them
    // has.
    let unused: Vec<String> = sqlx::query_scalar(chunks::UNUSED_BLOBS)
        .bind(&blobs)
        .fetch_all(conn)
        .await?;
    Ok((bytes, unused))
}

async fn existing_items(
    conn: &mut PgConnection,
    collection_id: i64,
    uids: &[&str],
) -> ApiResult<HashMap<String, ExistingItem>> {
    let rows: Vec<(String, i64, String)> = sqlx::query_as(
        "SELECT uid, id, revision_uid FROM items WHERE collection_id = $1 AND uid = ANY($2)",
    )
    .bind(collection_id)
    .bind(uids)
    .fetch_all(conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(uid, id, revision_uid)| (uid, ExistingItem { id, revision_uid }))
        .collect())
}

/// Store one new revision per item and make it the item's current one,
/// then drop what the new revisions made surplus, see [`prune`].
///
/// The caller holds the collection's row lock and has checked permissions
/// and etags. The whole batch is a handful of statements however many items
/// it carries.
async fn store_revisions(
    state: &AppState,
    conn: &mut PgConnection,
    collection: &Membership,
    author_id: i64,
    mut items: Vec<wire::Item>,
    existing: &HashMap<String, ExistingItem>,
) -> ApiResult<Stored> {
    // Uploading the revision an item already has is a retry, not a change.
    items.retain(|item| {
        existing
            .get(&item.uid)
            .is_none_or(|current| current.revision_uid != item.content.uid)
    });
    let mut written = Uncommitted::new(&state.blobs);
    if items.is_empty() {
        return Ok(Stored {
            stoken: None,
            freed_blobs: Vec::new(),
            written,
        });
    }

    // Only an owner with a plan has limits to look up, so a server without
    // any pays nothing here.
    if let Some(limits) = limits::for_writes(conn, collection.owner_id).await? {
        let (new_chunk_bytes, largest_item) = chunks::measure(conn, collection.id, &items).await?;
        let meta_bytes: i64 = items
            .iter()
            .map(|item| item.content.meta.len() as i64)
            .sum();
        let deletions_only = items.iter().all(|item| is_tombstone(item, existing));
        limits.check(new_chunk_bytes + meta_bytes, largest_item, deletions_only)?;
    }

    let (chunk_ids, chunk_bytes) =
        chunks::store(state, conn, collection, &mut items, &mut written).await?;
    let count = items.len() as i64;
    let first = next_changes(conn, count).await?;

    let mut new_uids = Vec::new();
    let mut new_versions: Vec<i16> = Vec::new();
    let mut new_keys: Vec<Option<Vec<u8>>> = Vec::new();
    let mut new_revisions = Vec::new();
    let mut new_stokens: Vec<i64> = Vec::new();
    let mut changed_ids: Vec<i64> = Vec::new();
    let mut changed_revisions = Vec::new();
    let mut changed_stokens: Vec<i64> = Vec::new();
    for (offset, item) in items.iter_mut().enumerate() {
        let stoken = first + offset as i64;
        match existing.get(&item.uid) {
            Some(current) => {
                changed_ids.push(current.id);
                changed_revisions.push(item.content.uid.clone());
                changed_stokens.push(stoken);
            }
            None => {
                new_uids.push(item.uid.clone());
                new_versions.push(i16::from(item.version));
                new_keys.push(item.encryption_key.take().map(ByteBuf::into_vec));
                new_revisions.push(item.content.uid.clone());
                new_stokens.push(stoken);
            }
        }
    }

    let mut item_ids: HashMap<String, i64> = existing
        .iter()
        .map(|(uid, item)| (uid.clone(), item.id))
        .collect();
    if !new_uids.is_empty() {
        let created: Vec<(String, i64)> = sqlx::query_as(
            "INSERT INTO items
                 (collection_id, uid, version, encryption_key, is_main, revision_uid, stoken)
             SELECT $1, u.uid, u.version, u.key, u.uid = $2, u.revision, u.stoken
             FROM UNNEST($3::text[], $4::int2[], $5::bytea[], $6::text[], $7::int8[])
                  AS u(uid, version, key, revision, stoken)
             RETURNING uid, id",
        )
        .bind(collection.id)
        .bind(&collection.uid)
        .bind(&new_uids)
        .bind(&new_versions)
        .bind(&new_keys)
        .bind(&new_revisions)
        .bind(&new_stokens)
        .fetch_all(&mut *conn)
        .await?;
        item_ids.extend(created);
    }
    if !changed_ids.is_empty() {
        sqlx::query(
            "UPDATE items i SET revision_uid = u.revision, stoken = u.stoken
             FROM UNNEST($1::int8[], $2::text[], $3::int8[]) AS u(id, revision, stoken)
             WHERE i.id = u.id",
        )
        .bind(&changed_ids)
        .bind(&changed_revisions)
        .bind(&changed_stokens)
        .execute(&mut *conn)
        .await?;
    }

    let mut rev_items: Vec<i64> = Vec::with_capacity(items.len());
    let mut rev_uids = Vec::with_capacity(items.len());
    let mut rev_metas: Vec<Vec<u8>> = Vec::with_capacity(items.len());
    let mut rev_deleted: Vec<bool> = Vec::with_capacity(items.len());
    let mut rev_chunks = Vec::with_capacity(items.len());
    let mut rev_stokens: Vec<i64> = Vec::with_capacity(items.len());
    let mut meta_bytes = 0i64;
    for (offset, item) in items.into_iter().enumerate() {
        let item_id = *item_ids
            .get(&item.uid)
            .ok_or_else(|| ApiError::internal("an item row went missing mid-write"))?;
        // Chunk ids travel as text because a batch of arrays of differing
        // lengths cannot be unnested as one parameter.
        let chunks = item
            .content
            .chunks
            .iter()
            .map(|chunk| {
                chunk_ids
                    .get(&chunk.0)
                    .map(i64::to_string)
                    .ok_or_else(|| ApiError::internal("a chunk row went missing mid-write"))
            })
            .collect::<ApiResult<Vec<_>>>()?
            .join(",");
        meta_bytes += item.content.meta.len() as i64;
        rev_items.push(item_id);
        rev_uids.push(item.content.uid);
        rev_metas.push(item.content.meta.into_vec());
        rev_deleted.push(item.content.deleted);
        rev_chunks.push(chunks);
        rev_stokens.push(first + offset as i64);
    }
    let stored = sqlx::query(
        "INSERT INTO revisions (item_id, uid, meta, deleted, chunk_ids, stoken, author_id)
         SELECT u.item_id, u.uid, u.meta, u.deleted,
                COALESCE(string_to_array(NULLIF(u.chunks, ''), ',')::bigint[], '{}'),
                u.stoken, $7
         FROM UNNEST($1::int8[], $2::text[], $3::bytea[], $4::bool[], $5::text[], $6::int8[])
              AS u(item_id, uid, meta, deleted, chunks, stoken)
         ON CONFLICT (item_id, uid) DO NOTHING",
    )
    .bind(&rev_items)
    .bind(&rev_uids)
    .bind(&rev_metas)
    .bind(&rev_deleted)
    .bind(&rev_chunks)
    .bind(&rev_stokens)
    .bind(author_id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if stored != count as u64 {
        // The client sent a revision uid this item already used for an
        // earlier revision. Nothing legitimate does that.
        return Err(ApiError::conflict(
            "item_failed",
            "A revision with this uid already exists for the item",
        ));
    }

    // Only an item that was there before has a revision to make surplus,
    // so a first upload, however large, skips this.
    let (bytes_back, freed_blobs) = if changed_ids.is_empty() {
        (0, Vec::new())
    } else {
        let keep = i64::from(state.config.keep_revisions);
        prune(conn, collection.id, &changed_ids, keep).await?
    };

    let stoken = first + count - 1;
    sqlx::query(
        "UPDATE collections
         SET stoken = $2, bytes_used = GREATEST(bytes_used + $3 - $4, 0)
         WHERE id = $1",
    )
    .bind(collection.id)
    .bind(stoken)
    .bind(chunk_bytes + meta_bytes)
    .bind(bytes_back)
    .execute(&mut *conn)
    .await?;
    Ok(Stored {
        stoken: Some(stoken),
        freed_blobs,
        written,
    })
}

/// Remove blobs a committed write left without rows. Failing costs disk
/// space and nothing else, so it is logged and not passed on.
async fn discard_blobs(state: &AppState, blobs: Vec<String>) {
    if blobs.is_empty() {
        return;
    }
    if let Err(err) = state.blobs.remove(blobs).await {
        tracing::warn!("could not remove blobs that are no longer used: {err}");
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WriteMode {
    /// Last writer wins: the items' own etags are not checked.
    Batch,
    /// All or nothing: every item must still be at the revision the client
    /// last saw.
    Transaction,
}

fn wrong_etag(uid: &str, expected: Option<&str>, current: Option<&str>) -> FieldError {
    FieldError {
        field: uid.to_owned(),
        code: "wrong_etag",
        detail: format!(
            "Wrong etag. Expected {} got {}",
            current.unwrap_or("none"),
            expected.unwrap_or("none")
        ),
    }
}

async fn write_items(
    state: AppState,
    user: AuthUser,
    collection_uid: String,
    query: FetchQuery,
    body: ItemBatch,
    mode: WriteMode,
) -> ApiResult<StatusCode> {
    validate_items(&body.items)?;
    let deps = body.deps.unwrap_or_default();
    if deps.len() > MAX_ITEMS_PER_REQUEST {
        return Err(ApiError::bad_request("Too many items in one request."));
    }

    let mut tx = state.pool.begin().await?;
    let collection = membership(&mut tx, user.account_id, &collection_uid, true).await?;
    collection.require_write()?;

    // The client may require that nothing at all changed in the collection
    // since it last looked. Anything that is not the current cursor fails,
    // including a value that was never a cursor.
    if let Some(token) = query.stoken.as_deref() {
        if state.keys.parse_stoken(token) != Some(collection.stoken) {
            return Err(ApiError::conflict("stale_stoken", "Stoken is too old"));
        }
    }

    let uids: Vec<&str> = body
        .items
        .iter()
        .map(|item| item.uid.as_str())
        .chain(deps.iter().map(|dep| dep.uid.as_str()))
        .collect();
    let existing = existing_items(&mut tx, collection.id, &uids).await?;
    let current = |uid: &str| existing.get(uid).map(|item| item.revision_uid.as_str());

    let mut failures = Vec::new();
    for dep in &deps {
        if dep.etag.is_some() && dep.etag.as_deref() != current(&dep.uid) {
            failures.push(wrong_etag(&dep.uid, dep.etag.as_deref(), current(&dep.uid)));
        }
    }
    if mode == WriteMode::Transaction {
        for item in &body.items {
            // A retry of a revision that already landed is not a conflict.
            let retry = current(&item.uid) == Some(item.content.uid.as_str());
            if !retry && item.etag.as_deref() != current(&item.uid) {
                failures.push(wrong_etag(
                    &item.uid,
                    item.etag.as_deref(),
                    current(&item.uid),
                ));
            }
        }
    }
    if !failures.is_empty() {
        let mut error = ApiError::conflict("item_failed", "Items failed to validate");
        error.errors = Some(failures);
        return Err(error);
    }

    let stored = store_revisions(
        &state,
        &mut tx,
        &collection,
        user.account_id,
        body.items,
        &existing,
    )
    .await?;
    if stored.stoken.is_some() {
        let event = Event::Changed {
            collection: collection.id,
            session: Some(user.session_id),
        };
        events::publish(&mut tx, &event).await?;
    }
    stored.written.keep();
    tx.commit().await?;
    discard_blobs(&state, stored.freed_blobs).await;
    Ok(StatusCode::OK)
}

pub async fn batch(
    State(state): State<AppState>,
    user: AuthUser,
    Path(collection_uid): Path<String>,
    Query(query): Query<FetchQuery>,
    Msgpack(body): Msgpack<ItemBatch>,
) -> ApiResult<StatusCode> {
    write_items(state, user, collection_uid, query, body, WriteMode::Batch).await
}

pub async fn transaction(
    State(state): State<AppState>,
    user: AuthUser,
    Path(collection_uid): Path<String>,
    Query(query): Query<FetchQuery>,
    Msgpack(body): Msgpack<ItemBatch>,
) -> ApiResult<StatusCode> {
    write_items(
        state,
        user,
        collection_uid,
        query,
        body,
        WriteMode::Transaction,
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// The property every cursor depends on. If a second writer could take a
    /// number before the first committed, the second could commit first, a
    /// reader could move its cursor past both numbers, and the first
    /// writer's change would then land behind the cursor for good.
    #[tokio::test]
    async fn a_writer_waits_for_the_previous_one_to_commit() {
        let pool = crate::testing::pool().await;

        let mut first = pool.begin().await.unwrap();
        let first_number = next_changes(&mut first, 3).await.unwrap();

        let second = tokio::spawn({
            let pool = pool.clone();
            async move {
                let mut tx = pool.begin().await.unwrap();
                let number = next_changes(&mut tx, 1).await.unwrap();
                tx.commit().await.unwrap();
                number
            }
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            !second.is_finished(),
            "a second writer took a change number while the first had not committed"
        );

        first.commit().await.unwrap();
        let second_number = second.await.unwrap();
        assert!(second_number >= first_number + 3);
    }
}
