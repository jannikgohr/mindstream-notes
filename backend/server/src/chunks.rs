//! Chunk storage.
//!
//! The client splits content into chunks and addresses each by a keyed hash
//! of its bytes, so within a collection an identical chunk is stored once
//! however many revisions refer to it. Small chunks sit in the database row;
//! the large chunks of one upload go into a single blob.

use std::collections::{HashMap, HashSet};

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_bytes::ByteBuf;
use sqlx::PgConnection;

use crate::auth::AuthUser;
use crate::blob::{BlobStore, Range};
use crate::collections::{membership, Membership};
use crate::error::{ApiError, ApiResult};
use crate::limits;
use crate::wire::{self, check_uid};
use crate::AppState;

/// The client's chunker never produces more than about 64 KiB, padded. This
/// leaves room and still bounds what one row can hold.
pub(crate) const MAX_CHUNK_BYTES: usize = 1024 * 1024;

#[derive(sqlx::FromRow)]
struct ChunkRow {
    id: i64,
    uid: String,
    size: i32,
    data: Option<Vec<u8>>,
    blob_key: Option<String>,
    blob_offset: Option<i64>,
}

fn no_content() -> ApiError {
    ApiError::internal("chunk row holds no content")
}

/// The chunks a response needs, fetched together. Each is handed out as many
/// times as it was asked for and only copied when it is needed again
/// afterwards, which for most responses is never.
pub(crate) struct Loaded {
    chunks: HashMap<i64, (String, Option<Vec<u8>>)>,
    uses_left: HashMap<i64, usize>,
}

impl Loaded {
    pub fn take(&mut self, id: i64) -> ApiResult<wire::Chunk> {
        let missing = || ApiError::internal("revision refers to a missing chunk");
        let uses = self.uses_left.get_mut(&id).ok_or_else(missing)?;
        *uses = uses.saturating_sub(1);
        let (uid, content) = if *uses == 0 {
            self.chunks.remove(&id).ok_or_else(missing)?
        } else {
            self.chunks.get(&id).cloned().ok_or_else(missing)?
        };
        Ok(wire::Chunk(uid, content.map(ByteBuf::from)))
    }
}

/// Fetch the chunks with the given row ids, once per time an id appears.
/// Without content, only their uids come back and the client downloads what
/// it wants later.
pub(crate) async fn load(
    conn: &mut PgConnection,
    blobs: &BlobStore,
    ids: impl Iterator<Item = i64>,
    with_content: bool,
) -> ApiResult<Loaded> {
    let mut uses_left: HashMap<i64, usize> = HashMap::new();
    for id in ids {
        *uses_left.entry(id).or_default() += 1;
    }
    let mut chunks = HashMap::with_capacity(uses_left.len());
    if uses_left.is_empty() {
        return Ok(Loaded { chunks, uses_left });
    }
    let wanted: Vec<i64> = uses_left.keys().copied().collect();

    if !with_content {
        let rows: Vec<(i64, String)> =
            sqlx::query_as("SELECT id, uid FROM chunks WHERE id = ANY($1)")
                .bind(&wanted)
                .fetch_all(conn)
                .await?;
        chunks.extend(rows.into_iter().map(|(id, uid)| (id, (uid, None))));
        return Ok(Loaded { chunks, uses_left });
    }

    let rows: Vec<ChunkRow> = sqlx::query_as(
        "SELECT id, uid, size, data, blob_key, blob_offset FROM chunks WHERE id = ANY($1)",
    )
    .bind(&wanted)
    .fetch_all(conn)
    .await?;
    // Group what lives in the blob store by blob, so each is opened once.
    let mut by_blob: HashMap<String, Vec<(i64, String, Range)>> = HashMap::new();
    for row in rows {
        match (row.data, row.blob_key, row.blob_offset) {
            (Some(data), _, _) => {
                chunks.insert(row.id, (row.uid, Some(data)));
            }
            (None, Some(key), Some(offset)) => {
                let range = Range {
                    offset: offset as u64,
                    len: row.size as usize,
                };
                by_blob
                    .entry(key)
                    .or_default()
                    .push((row.id, row.uid, range));
            }
            _ => return Err(no_content()),
        }
    }
    let (requests, owners): (Vec<_>, Vec<_>) = by_blob
        .into_iter()
        .map(|(key, parts)| {
            let ranges = parts.iter().map(|part| part.2).collect();
            ((key, ranges), parts)
        })
        .unzip();
    for (parts, contents) in owners.into_iter().zip(blobs.get_many(requests).await?) {
        for ((id, uid, _), content) in parts.into_iter().zip(contents) {
            chunks.insert(id, (uid, Some(content)));
        }
    }
    Ok(Loaded { chunks, uses_left })
}

/// What storing these revisions' content would come to, without storing
/// anything: the bytes of the chunks the collection does not have yet, and
/// the content size of the largest item. For checking limits first.
pub(crate) async fn measure(
    conn: &mut PgConnection,
    collection_id: i64,
    items: &[wire::Item],
) -> ApiResult<(i64, i64)> {
    let referenced: Vec<&str> = items
        .iter()
        .flat_map(|item| item.content.chunks.iter().map(|chunk| chunk.0.as_str()))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let stored: HashMap<String, i32> = if referenced.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, (String, i32)>(
            "SELECT uid, size FROM chunks WHERE collection_id = $1 AND uid = ANY($2)",
        )
        .bind(collection_id)
        .bind(&referenced)
        .fetch_all(conn)
        .await?
        .into_iter()
        .collect()
    };

    let mut counted = HashSet::new();
    let mut new_bytes = 0i64;
    let mut largest = 0i64;
    for item in items {
        let mut size = 0i64;
        for chunk in &item.content.chunks {
            let uploaded = chunk.1.as_ref().map_or(0, |content| content.len() as i64);
            match stored.get(&chunk.0) {
                Some(existing) => size += i64::from(*existing),
                None => {
                    size += uploaded;
                    // A chunk shared by several items is stored once.
                    if counted.insert(chunk.0.as_str()) {
                        new_bytes += uploaded;
                    }
                }
            }
        }
        largest = largest.max(size);
    }
    Ok((new_bytes, largest))
}

/// Make sure every chunk the revisions refer to is stored, and return their
/// row ids and how many new bytes that took.
pub(crate) async fn store(
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
    let mut offsets: Vec<Option<i64>> = Vec::new();
    let mut blob = Vec::new();
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
        if content.len() <= state.config.inline_chunk_bytes {
            inline.push(Some(content));
            offsets.push(None);
        } else {
            offsets.push(Some(blob.len() as i64));
            blob.extend_from_slice(&content);
            inline.push(None);
        }
        uids.push(uid.clone());
    }
    if uids.is_empty() {
        return Ok((ids, 0));
    }

    // The blob first: a row must never point at bytes that are not there
    // yet. If the transaction then fails, the blob is left behind unused,
    // which costs space and nothing else.
    let mut blob_key = None;
    if !blob.is_empty() {
        let key = BlobStore::new_key(&collection.uid);
        state.blobs.put(&key, blob).await?;
        blob_key = Some(key);
    }
    let blob_keys: Vec<Option<String>> = offsets
        .iter()
        .map(|offset| offset.and(blob_key.clone()))
        .collect();

    let inserted: Vec<(String, i64, i32)> = sqlx::query_as(
        "INSERT INTO chunks (collection_id, uid, size, data, blob_key, blob_offset)
         SELECT $1, u.uid, u.size, u.data, u.blob_key, u.blob_offset
         FROM UNNEST($2::text[], $3::int4[], $4::bytea[], $5::text[], $6::int8[])
              AS u(uid, size, data, blob_key, blob_offset)
         ON CONFLICT (collection_id, uid) DO NOTHING
         RETURNING uid, id, size",
    )
    .bind(collection.id)
    .bind(&uids)
    .bind(&sizes)
    .bind(&inline)
    .bind(&blob_keys)
    .bind(&offsets)
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
    if let Some(limits) = limits::for_writes(&mut tx, collection.owner_id).await? {
        limits.check(body.len() as i64, body.len() as i64, false)?;
    }

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
    let (data, blob_key, blob_offset) = if body.len() <= state.config.inline_chunk_bytes {
        (Some(body.to_vec()), None, None)
    } else {
        let key = BlobStore::new_key(&collection.uid);
        state.blobs.put(&key, body.to_vec()).await?;
        (None, Some(key), Some(0i64))
    };
    let inserted = sqlx::query(
        "INSERT INTO chunks (collection_id, uid, size, data, blob_key, blob_offset)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (collection_id, uid) DO NOTHING",
    )
    .bind(collection.id)
    .bind(&chunk_uid)
    .bind(size)
    .bind(&data)
    .bind(&blob_key)
    .bind(blob_offset)
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
    let row: Option<ChunkRow> = sqlx::query_as(
        "SELECT id, uid, size, data, blob_key, blob_offset FROM chunks
         WHERE collection_id = $1 AND uid = $2",
    )
    .bind(collection.id)
    .bind(&chunk_uid)
    .fetch_optional(&mut *conn)
    .await?;
    let row = row.ok_or_else(|| ApiError::not_found("Chunk"))?;
    let content = match (row.data, row.blob_key, row.blob_offset) {
        (Some(data), _, _) => data,
        (None, Some(key), Some(offset)) => {
            let range = Range {
                offset: offset as u64,
                len: row.size as usize,
            };
            state
                .blobs
                .get_ranges(&key, vec![range])
                .await?
                .pop()
                .ok_or_else(no_content)?
        }
        _ => return Err(no_content()),
    };
    Ok((
        [(header::CONTENT_TYPE, "application/octet-stream")],
        content,
    )
        .into_response())
}
