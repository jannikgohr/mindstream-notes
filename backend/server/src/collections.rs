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

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_bytes::ByteBuf;
use sqlx::PgConnection;

use crate::auth::AuthUser;
use crate::blob::BlobStore;
use crate::error::{ApiError, ApiResult, FieldError};
use crate::wire::{
    self, check_uid, valid_uid, CollectionCreate, CollectionList, FetchQuery, ItemBatch, ItemList,
    ItemRef, IteratorList, ListMulti, Msgpack, RemovedCollection, ACCESS_ADMIN, ACCESS_READ_ONLY,
};
use crate::AppState;

/// The client's chunker never produces more than about 64 KiB, padded. This
/// leaves room and still bounds what one row can hold.
const MAX_CHUNK_BYTES: usize = 1024 * 1024;
const MAX_META_BYTES: usize = 64 * 1024;
const MAX_ITEMS_PER_REQUEST: usize = 10_000;

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
/// which serialises writers to one collection.
pub(crate) async fn membership(
    conn: &mut PgConnection,
    account_id: i64,
    collection_uid: &str,
    lock: bool,
) -> ApiResult<Membership> {
    check_uid(collection_uid)?;
    let row: Option<(i64, i64, i64, i16)> = sqlx::query_as(&format!(
        "SELECT c.id, c.owner_id, c.stoken, m.access_level
         FROM collections c
         JOIN members m ON m.collection_id = c.id AND m.account_id = $2
         WHERE c.uid = $1 {}",
        if lock { "FOR UPDATE OF c" } else { "" }
    ))
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

#[derive(sqlx::FromRow)]
struct ChunkRow {
    id: i64,
    uid: String,
    data: Option<Vec<u8>>,
    blob_key: Option<String>,
}

/// A chunk's uid and, when it was asked for, its content.
type LoadedChunks = HashMap<i64, (String, Option<Vec<u8>>)>;

/// Fetch the chunks a set of revisions refers to. Without content, only
/// their uids come back and the client downloads what it wants later.
async fn load_chunks(
    conn: &mut PgConnection,
    blobs: &BlobStore,
    ids: impl Iterator<Item = i64>,
    with_content: bool,
) -> ApiResult<LoadedChunks> {
    let ids: Vec<i64> = ids.collect::<HashSet<_>>().into_iter().collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    if !with_content {
        let rows: Vec<(i64, String)> =
            sqlx::query_as("SELECT id, uid FROM chunks WHERE id = ANY($1)")
                .bind(&ids)
                .fetch_all(conn)
                .await?;
        return Ok(rows
            .into_iter()
            .map(|(id, uid)| (id, (uid, None)))
            .collect());
    }
    let rows: Vec<ChunkRow> =
        sqlx::query_as("SELECT id, uid, data, blob_key FROM chunks WHERE id = ANY($1)")
            .bind(&ids)
            .fetch_all(conn)
            .await?;
    let mut chunks = HashMap::with_capacity(rows.len());
    for row in rows {
        let content = match (row.data, row.blob_key) {
            (Some(data), _) => data,
            (None, Some(key)) => blobs.get(&key).await?,
            (None, None) => return Err(ApiError::internal("chunk row holds no content")),
        };
        chunks.insert(row.id, (row.uid, Some(content)));
    }
    Ok(chunks)
}

fn to_wire_revision(
    uid: String,
    meta: Vec<u8>,
    deleted: bool,
    chunk_ids: &[i64],
    chunks: &LoadedChunks,
) -> ApiResult<wire::Revision> {
    let chunks = chunk_ids
        .iter()
        .map(|id| {
            let (uid, content) = chunks
                .get(id)
                .ok_or_else(|| ApiError::internal("revision refers to a missing chunk"))?;
            Ok(wire::Chunk(
                uid.clone(),
                content.as_ref().map(|bytes| ByteBuf::from(bytes.clone())),
            ))
        })
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(wire::Revision {
        uid,
        meta: ByteBuf::from(meta),
        deleted,
        chunks,
    })
}

fn to_wire_item(row: ItemRow, chunks: &LoadedChunks) -> ApiResult<wire::Item> {
    Ok(wire::Item {
        uid: row.uid,
        version: row.version as u8,
        encryption_key: row.encryption_key.map(ByteBuf::from),
        content: to_wire_revision(row.rev_uid, row.meta, row.deleted, &row.chunk_ids, chunks)?,
        etag: None,
    })
}

async fn to_wire_items(
    state: &AppState,
    conn: &mut PgConnection,
    rows: Vec<ItemRow>,
    with_content: bool,
) -> ApiResult<Vec<wire::Item>> {
    let chunks = load_chunks(
        conn,
        &state.blobs,
        rows.iter().flat_map(|row| row.chunk_ids.iter().copied()),
        with_content,
    )
    .await?;
    rows.into_iter()
        .map(|row| to_wire_item(row, &chunks))
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
    let chunks = load_chunks(
        conn,
        &state.blobs,
        rows.iter()
            .flat_map(|row| row.item.chunk_ids.iter().copied()),
        with_content,
    )
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(wire::Collection {
                access_level: row.access_level,
                collection_key: ByteBuf::from(row.member_key),
                collection_type: ByteBuf::from(row.collection_type),
                stoken: state.keys.stoken(row.col_stoken),
                item: to_wire_item(row.item, &chunks)?,
            })
        })
        .collect()
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
    let mut conn = state.pool.acquire().await?;

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

    let stoken = store_revisions(
        &state,
        &mut tx,
        &collection,
        user.account_id,
        vec![body.item],
        &HashMap::new(),
    )
    .await?
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
    let done = rows.len() as i64 <= limit;
    rows.truncate(limit as usize);
    let stoken = rows
        .last()
        .map(|row| state.keys.stoken(row.stoken))
        .or_else(|| query.stoken.clone());

    Ok(Msgpack(ItemList {
        data: to_wire_items(&state, &mut conn, rows, query.with_content()).await?,
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

    let chunks = load_chunks(
        &mut conn,
        &state.blobs,
        rows.iter().flat_map(|row| row.3.iter().copied()),
        query.with_content(),
    )
    .await?;
    let iterator = rows.last().map(|row| row.0.clone());
    let data = rows
        .into_iter()
        .map(|(uid, meta, deleted, chunk_ids)| {
            to_wire_revision(uid, meta, deleted, &chunk_ids, &chunks)
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
        for chunk in &item.content.chunks {
            if !valid_uid(&chunk.0) {
                return Err(ApiError::bad_request("Malformed uid"));
            }
            if chunk.1.as_ref().is_some_and(|c| c.len() > MAX_CHUNK_BYTES) {
                return Err(ApiError::bad_request("Chunk is too large."));
            }
        }
    }
    Ok(())
}

/// Where a chunk's bytes go: the database row when small, the blob store
/// otherwise. Returns the two column values, of which exactly one is set.
async fn place_chunk(
    state: &AppState,
    collection_uid: &str,
    chunk_uid: &str,
    content: Vec<u8>,
) -> ApiResult<(Option<Vec<u8>>, Option<String>)> {
    if content.len() <= state.config.inline_chunk_bytes {
        return Ok((Some(content), None));
    }
    let key = BlobStore::chunk_key(collection_uid, chunk_uid);
    state.blobs.put(&key, &content).await?;
    Ok((None, Some(key)))
}

/// Make sure every chunk the revisions refer to is stored, and return their
/// row ids and how many new bytes that took.
async fn store_chunks(
    state: &AppState,
    conn: &mut PgConnection,
    collection: &Membership,
    items: &mut [wire::Item],
) -> ApiResult<(HashMap<String, i64>, i64)> {
    // A chunk can appear in several revisions; keep the first copy of its
    // content and drop the rest.
    let mut uploaded: HashMap<String, Vec<u8>> = HashMap::new();
    let mut referenced: HashSet<String> = HashSet::new();
    for item in items.iter_mut() {
        for chunk in item.content.chunks.iter_mut() {
            referenced.insert(chunk.0.clone());
            if let Some(content) = chunk.1.take() {
                uploaded
                    .entry(chunk.0.clone())
                    .or_insert_with(|| content.into_vec());
            }
        }
    }
    if referenced.is_empty() {
        return Ok((HashMap::new(), 0));
    }

    let referenced: Vec<String> = referenced.into_iter().collect();
    let find = "SELECT uid, id FROM chunks WHERE collection_id = $1 AND uid = ANY($2)";
    let mut ids: HashMap<String, i64> = sqlx::query_as::<_, (String, i64)>(find)
        .bind(collection.id)
        .bind(&referenced)
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .collect();

    let mut uids = Vec::new();
    let mut sizes: Vec<i32> = Vec::new();
    let mut inline: Vec<Option<Vec<u8>>> = Vec::new();
    let mut blob_keys: Vec<Option<String>> = Vec::new();
    for uid in &referenced {
        if ids.contains_key(uid) {
            continue;
        }
        let Some(content) = uploaded.remove(uid) else {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "chunk_no_content",
                "Tried to create a new chunk without content",
            ));
        };
        sizes.push(content.len() as i32);
        let (data, key) = place_chunk(state, &collection.uid, uid, content).await?;
        inline.push(data);
        blob_keys.push(key);
        uids.push(uid.clone());
    }
    if uids.is_empty() {
        return Ok((ids, 0));
    }

    let inserted: Vec<(String, i64, i32)> = sqlx::query_as(
        "INSERT INTO chunks (collection_id, uid, size, data, blob_key)
         SELECT $1, u.uid, u.size, u.data, u.blob_key
         FROM UNNEST($2::text[], $3::int4[], $4::bytea[], $5::text[])
              AS u(uid, size, data, blob_key)
         ON CONFLICT (collection_id, uid) DO NOTHING
         RETURNING uid, id, size",
    )
    .bind(collection.id)
    .bind(&uids)
    .bind(&sizes)
    .bind(&inline)
    .bind(&blob_keys)
    .fetch_all(&mut *conn)
    .await?;
    let mut bytes_added = 0i64;
    for (uid, id, size) in inserted {
        bytes_added += i64::from(size);
        ids.insert(uid, id);
    }
    // A chunk uploaded on its own at the same moment wins the insert above
    // and is not returned by it. Pick those up.
    if uids.iter().any(|uid| !ids.contains_key(uid)) {
        let raced: Vec<(String, i64)> = sqlx::query_as(find)
            .bind(collection.id)
            .bind(&uids)
            .fetch_all(&mut *conn)
            .await?;
        ids.extend(raced);
    }
    Ok((ids, bytes_added))
}

pub(crate) struct ExistingItem {
    id: i64,
    revision_uid: String,
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

/// Store one new revision per item and make it the item's current one.
/// Returns the collection's new cursor, or `None` when every revision was
/// already there.
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
) -> ApiResult<Option<i64>> {
    // Uploading the revision an item already has is a retry, not a change.
    items.retain(|item| {
        existing
            .get(&item.uid)
            .is_none_or(|current| current.revision_uid != item.content.uid)
    });
    if items.is_empty() {
        return Ok(None);
    }

    let (chunk_ids, chunk_bytes) = store_chunks(state, conn, collection, &mut items).await?;
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

    let stoken = first + count - 1;
    sqlx::query("UPDATE collections SET stoken = $2, bytes_used = bytes_used + $3 WHERE id = $1")
        .bind(collection.id)
        .bind(stoken)
        .bind(chunk_bytes + meta_bytes)
        .execute(&mut *conn)
        .await?;
    Ok(Some(stoken))
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

    store_revisions(
        &state,
        &mut tx,
        &collection,
        user.account_id,
        body.items,
        &existing,
    )
    .await?;
    tx.commit().await?;
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

// ---------- chunks on their own ----------

/// Upload one chunk ahead of the revision that will refer to it. The item in
/// the path need not exist yet.
pub async fn upload_chunk(
    State(state): State<AppState>,
    user: AuthUser,
    Path((collection_uid, item_uid, chunk_uid)): Path<(String, String, String)>,
    body: Bytes,
) -> ApiResult<StatusCode> {
    check_uid(&item_uid)?;
    check_uid(&chunk_uid)?;
    if body.len() > MAX_CHUNK_BYTES {
        return Err(ApiError::bad_request("Chunk is too large."));
    }
    let mut tx = state.pool.begin().await?;
    let collection = membership(&mut tx, user.account_id, &collection_uid, false).await?;
    collection.require_write()?;

    let exists: Option<i64> =
        sqlx::query_scalar("SELECT id FROM chunks WHERE collection_id = $1 AND uid = $2")
            .bind(collection.id)
            .bind(&chunk_uid)
            .fetch_optional(&mut *tx)
            .await?;
    let chunk_exists = || ApiError::conflict("chunk_exists", "Chunk already exists.");
    if exists.is_some() {
        return Err(chunk_exists());
    }

    let size = body.len() as i32;
    let (data, blob_key) = place_chunk(&state, &collection.uid, &chunk_uid, body.to_vec()).await?;
    let inserted = sqlx::query(
        "INSERT INTO chunks (collection_id, uid, size, data, blob_key)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (collection_id, uid) DO NOTHING",
    )
    .bind(collection.id)
    .bind(&chunk_uid)
    .bind(size)
    .bind(&data)
    .bind(&blob_key)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if inserted == 0 {
        return Err(chunk_exists());
    }
    sqlx::query("UPDATE collections SET bytes_used = bytes_used + $2 WHERE id = $1")
        .bind(collection.id)
        .bind(i64::from(size))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::CREATED)
}

pub async fn download_chunk(
    State(state): State<AppState>,
    user: AuthUser,
    Path((collection_uid, item_uid, chunk_uid)): Path<(String, String, String)>,
) -> ApiResult<Response> {
    check_uid(&item_uid)?;
    check_uid(&chunk_uid)?;
    let mut conn = state.pool.acquire().await?;
    let collection = membership(&mut conn, user.account_id, &collection_uid, false).await?;
    let row: Option<(Option<Vec<u8>>, Option<String>)> =
        sqlx::query_as("SELECT data, blob_key FROM chunks WHERE collection_id = $1 AND uid = $2")
            .bind(collection.id)
            .bind(&chunk_uid)
            .fetch_optional(&mut *conn)
            .await?;
    let content = match row.ok_or_else(|| ApiError::not_found("Chunk"))? {
        (Some(data), _) => data,
        (None, Some(key)) => state.blobs.get(&key).await?,
        (None, None) => return Err(ApiError::internal("chunk row holds no content")),
    };
    Ok((
        [(header::CONTENT_TYPE, "application/octet-stream")],
        content,
    )
        .into_response())
}
