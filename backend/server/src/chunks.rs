//! Chunk storage.
//!
//! The client splits content into chunks and addresses each by a keyed hash
//! of its bytes, so within a collection an identical chunk is stored once
//! however many revisions refer to it. Small chunks sit in the database row;
//! the large chunks of one upload go into a single blob.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::stream::TryChunksError;
use futures_util::TryStreamExt;
use serde_bytes::ByteBuf;
use sqlx::{PgConnection, PgPool};

use crate::auth::AuthUser;
use crate::blob::{BlobStore, Range, Uncommitted};
use crate::collections::{membership, Membership};
use crate::error::{ApiError, ApiResult};
use crate::limits;
use crate::wire::{self, check_uid};
use crate::AppState;

/// The client's chunker never produces more than about 64 KiB, padded. This
/// leaves room and still bounds what one row can hold.
pub(crate) const MAX_CHUNK_BYTES: usize = 1024 * 1024;

/// Of the blob keys in `$1`, those no chunk row points into.
pub(crate) const UNUSED_BLOBS: &str = "SELECT key FROM UNNEST($1::text[]) AS key
     WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.blob_key = key)";
/// How long a blob may have gone without rows before the sweep takes it. A
/// write puts its blob before it inserts the rows and commits them moments
/// later. This is far longer than any transaction stays open.
const RECLAIM_GRACE: Duration = Duration::from_secs(24 * 60 * 60);
const RECLAIM_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// Blob keys asked about in one query.
const RECLAIM_BATCH: usize = 1000;

#[derive(sqlx::FromRow)]
struct ChunkRow {
    id: i64,
    size: i32,
    data: Option<Vec<u8>>,
    blob_key: Option<String>,
    blob_offset: Option<i64>,
}

fn no_content() -> ApiError {
    ApiError::internal("chunk row holds no content")
}

/// How many of these sizes, taken in order from the first, fit a budget
/// together.
pub(crate) fn fitting(sizes: impl Iterator<Item = i64>, budget: i64) -> usize {
    let mut total = 0i64;
    sizes
        .take_while(|size| {
            total = total.saturating_add(*size);
            total <= budget
        })
        .count()
}

/// The chunks of the revisions one response carries, and the content of as
/// many of those revisions as it has room for.
///
/// A response is built in memory, so its content is held to a budget. The
/// revisions are taken in order: those that fit together go out whole, and
/// the rest go out as the uids of their chunks, which a client fetches one
/// at a time. Without this a single request could ask for more than the
/// process can hold.
pub(crate) struct Loaded {
    uids: HashMap<i64, String>,
    content: HashMap<i64, Vec<u8>>,
    /// How often each chunk is still to be handed out with its content. A
    /// chunk is only copied when it is needed again afterwards, which for
    /// most responses is never.
    uses_left: HashMap<i64, usize>,
    /// How many of the revisions, from the first, go out with content.
    with_content: usize,
    taken: usize,
}

impl Loaded {
    /// How many of the revisions, from the first, go out with content.
    pub fn fitting(&self) -> usize {
        self.with_content
    }

    /// The chunks of the next revision. Call it for the revisions in the
    /// order they were given to [`load`].
    pub fn revision(&mut self, chunk_ids: &[i64]) -> ApiResult<Vec<wire::Chunk>> {
        let missing = || ApiError::internal("revision refers to a missing chunk");
        let with_content = self.taken < self.with_content;
        self.taken += 1;
        chunk_ids
            .iter()
            .map(|id| {
                let uid = self.uids.get(id).ok_or_else(missing)?.clone();
                if !with_content {
                    return Ok(wire::Chunk(uid, None));
                }
                let uses = self.uses_left.get_mut(id).ok_or_else(missing)?;
                *uses = uses.saturating_sub(1);
                let content = if *uses == 0 {
                    self.content.remove(id)
                } else {
                    self.content.get(id).cloned()
                };
                Ok(wire::Chunk(
                    uid,
                    Some(ByteBuf::from(content.ok_or_else(missing)?)),
                ))
            })
            .collect()
    }
}

/// Fetch what a response needs of these revisions' chunks. Each revision is
/// the row ids of its chunks. Without content, only the uids are read.
pub(crate) async fn load(
    conn: &mut PgConnection,
    blobs: &BlobStore,
    revisions: &[&[i64]],
    with_content: bool,
    budget: i64,
) -> ApiResult<Loaded> {
    let mut loaded = Loaded {
        uids: HashMap::new(),
        content: HashMap::new(),
        uses_left: HashMap::new(),
        with_content: 0,
        taken: 0,
    };
    let referenced: Vec<i64> = revisions
        .iter()
        .flat_map(|ids| ids.iter().copied())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if referenced.is_empty() {
        // Nothing to read, so nothing to hold back.
        loaded.with_content = if with_content { revisions.len() } else { 0 };
        return Ok(loaded);
    }

    let index: Vec<(i64, String, i32)> =
        sqlx::query_as("SELECT id, uid, size FROM chunks WHERE id = ANY($1)")
            .bind(&referenced)
            .fetch_all(&mut *conn)
            .await?;
    let mut sizes: HashMap<i64, i64> = HashMap::with_capacity(index.len());
    for (id, uid, size) in index {
        sizes.insert(id, i64::from(size));
        loaded.uids.insert(id, uid);
    }
    if !with_content {
        return Ok(loaded);
    }

    let size_of = |ids: &&[i64]| -> i64 {
        ids.iter()
            .map(|id| sizes.get(id).copied().unwrap_or(0))
            .fold(0, i64::saturating_add)
    };
    loaded.with_content = fitting(revisions.iter().map(size_of), budget);
    for ids in &revisions[..loaded.with_content] {
        for id in ids.iter() {
            *loaded.uses_left.entry(*id).or_default() += 1;
        }
    }
    if loaded.uses_left.is_empty() {
        return Ok(loaded);
    }
    let wanted: Vec<i64> = loaded.uses_left.keys().copied().collect();

    let rows: Vec<ChunkRow> = sqlx::query_as(
        "SELECT id, size, data, blob_key, blob_offset FROM chunks WHERE id = ANY($1)",
    )
    .bind(&wanted)
    .fetch_all(conn)
    .await?;
    // Group what lives in the blob store by blob, so each is opened once.
    let mut by_blob: HashMap<String, Vec<(i64, Range)>> = HashMap::new();
    for row in rows {
        match (row.data, row.blob_key, row.blob_offset) {
            (Some(data), _, _) => {
                loaded.content.insert(row.id, data);
            }
            (None, Some(key), Some(offset)) => {
                let range = Range {
                    offset: offset as u64,
                    len: row.size as usize,
                };
                by_blob.entry(key).or_default().push((row.id, range));
            }
            _ => return Err(no_content()),
        }
    }
    let (requests, owners): (Vec<_>, Vec<_>) = by_blob
        .into_iter()
        .map(|(key, parts)| {
            let ranges = parts.iter().map(|part| part.1).collect();
            ((key, ranges), parts)
        })
        .unzip();
    for (parts, contents) in owners.into_iter().zip(blobs.get_many(requests).await?) {
        for ((id, _), content) in parts.into_iter().zip(contents) {
            loaded.content.insert(id, content);
        }
    }
    Ok(loaded)
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

    // A new chunk is stored once, with the first content the request gives
    // it, as `store` does. An item may name it without content and leave
    // that to another, so its size is that content's wherever it appears.
    let mut uploaded: HashMap<&str, i64> = HashMap::new();
    for chunk in items.iter().flat_map(|item| &item.content.chunks) {
        if let (Some(content), false) = (&chunk.1, stored.contains_key(&chunk.0)) {
            uploaded
                .entry(chunk.0.as_str())
                .or_insert(content.len() as i64);
        }
    }
    let new_bytes = uploaded.values().sum();
    let largest = items
        .iter()
        .map(|item| {
            item.content
                .chunks
                .iter()
                .map(|chunk| match stored.get(&chunk.0) {
                    Some(existing) => i64::from(*existing),
                    None => uploaded.get(chunk.0.as_str()).copied().unwrap_or(0),
                })
                .sum::<i64>()
        })
        .max()
        .unwrap_or(0);
    Ok((new_bytes, largest))
}

/// Make sure every chunk the revisions refer to is stored, and return their
/// row ids and how many new bytes that took. A blob it writes is noted in
/// `written`, which removes it unless the transaction goes on to commit.
pub(crate) async fn store(
    state: &AppState,
    conn: &mut PgConnection,
    collection: &Membership,
    items: &mut [wire::Item],
    written: &mut Uncommitted,
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
    // yet. If the transaction then fails, `written` takes the blob away.
    let mut blob_key = None;
    if !blob.is_empty() {
        let key = BlobStore::new_key(&collection.uid);
        written.put(key.clone(), blob).await?;
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

/// Remove the blobs written more than `grace` ago that no chunk row points
/// into, and return how many there were. A write cleans up after itself when
/// it fails, but not after a crash, nor when it cannot tell whether its
/// commit went through; nothing else would ever take those blobs away.
pub(crate) async fn reclaim_blobs(
    pool: &PgPool,
    blobs: &BlobStore,
    grace: Duration,
) -> ApiResult<usize> {
    let mut written = blobs
        .written_before(grace)
        .try_chunks(RECLAIM_BATCH)
        .map_err(|TryChunksError(_, err)| err);
    let mut reclaimed = 0;
    while let Some(keys) = written.try_next().await? {
        let unused: Vec<String> = sqlx::query_scalar(UNUSED_BLOBS)
            .bind(&keys)
            .fetch_all(pool)
            .await?;
        reclaimed += unused.len();
        blobs.remove(unused).await?;
    }
    Ok(reclaimed)
}

/// Sweep for blobs nothing uses, now and then for as long as the process
/// runs, see [`reclaim_blobs`].
pub fn reclaim_blobs_periodically(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(RECLAIM_EVERY);
        loop {
            tick.tick().await;
            match reclaim_blobs(&state.pool, &state.blobs, RECLAIM_GRACE).await {
                Ok(0) => {}
                Ok(count) => tracing::info!("removed {count} blob(s) that nothing used"),
                Err(_) => tracing::warn!("could not look for blobs that nothing uses"),
            }
        }
    });
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
    let mut written = Uncommitted::new(&state.blobs);
    let (data, blob_key, blob_offset) = if body.len() <= state.config.inline_chunk_bytes {
        (Some(body.to_vec()), None, None)
    } else {
        let key = BlobStore::new_key(&collection.uid);
        written.put(key.clone(), body.to_vec()).await?;
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
    written.keep();
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
        "SELECT id, size, data, blob_key, blob_offset FROM chunks
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{random_bytes, to_base64};

    #[test]
    fn content_goes_out_for_the_revisions_that_fit_together_from_the_first() {
        let fit = |sizes: &[i64], budget| fitting(sizes.iter().copied(), budget);
        assert_eq!(fit(&[], 100), 0);
        assert_eq!(fit(&[10, 20, 30], 100), 3);
        assert_eq!(fit(&[60, 40, 1], 100), 2);
        assert_eq!(fit(&[60, 41, 1], 100), 1);
        // One larger than the whole budget does not go out whole, even
        // first, and nothing after it does either.
        assert_eq!(fit(&[500, 1], 100), 0);
        // Revisions without content never use the budget up.
        assert_eq!(fit(&[0, 0, 0, 0], 0), 4);
        // Sizes that would overflow when added up do not wrap round to fit.
        assert_eq!(fit(&[i64::MAX - 5, 10, 1], i64::MAX - 1), 1);
    }

    /// The sweep takes an old blob that no row points into, and leaves the
    /// blobs rows point into, the young ones, and files that are not blobs.
    #[tokio::test]
    async fn sweep_takes_only_old_blobs_that_nothing_uses() {
        let pool = crate::testing::pool().await;
        let dir = std::env::temp_dir().join(format!(
            "mindstream-reclaim-test-{}",
            to_base64(&random_bytes::<8>())
        ));
        let blobs = BlobStore::open(&dir).await.unwrap();
        let collection = to_base64(&random_bytes::<16>());
        let (used, unused) = (
            BlobStore::new_key(&collection),
            BlobStore::new_key(&collection),
        );
        for key in [&used, &unused] {
            blobs.put(key, b"data".to_vec()).await.unwrap();
        }
        std::fs::write(dir.join("secret.key"), b"not a blob").unwrap();
        let owner: i64 = sqlx::query_scalar(
            "WITH owner AS (
                 INSERT INTO accounts (username, username_key, email, version, salt,
                                       login_pubkey, pubkey, encrypted_content)
                 VALUES ($1, $1, '', 1, '', '', '', '') RETURNING id
             ), collection AS (
                 INSERT INTO collections (uid, owner_id, stoken)
                 SELECT $1, id, 0 FROM owner RETURNING id
             ), chunk AS (
                 INSERT INTO chunks (collection_id, uid, size, blob_key, blob_offset)
                 SELECT id, 'chunk', 4, $2, 0 FROM collection
             )
             SELECT id FROM owner",
        )
        .bind(&collection)
        .bind(&used)
        .fetch_one(&pool)
        .await
        .unwrap();

        let hour = Duration::from_secs(3600);
        assert_eq!(reclaim_blobs(&pool, &blobs, hour).await.unwrap(), 0);
        assert_eq!(
            reclaim_blobs(&pool, &blobs, Duration::ZERO).await.unwrap(),
            1
        );
        let whole = || vec![Range { offset: 0, len: 4 }];
        assert!(blobs.get_ranges(&unused, whole()).await.is_err());
        assert!(blobs.get_ranges(&used, whole()).await.is_ok());
        assert!(dir.join("secret.key").exists());

        sqlx::query("DELETE FROM accounts WHERE id = $1")
            .bind(owner)
            .execute(&pool)
            .await
            .unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
