//! Etebase sync — pull/push loop for notes and folders.
//!
//! Two parallel Etebase Collections back the local SQLite store:
//!
//!   * `mindstream.folders` — items typed `ms-md-folder`. Content is a
//!     msgpack-encoded `FolderPayload`. No body, just placement metadata.
//!   * `mindstream.notes`   — items typed `ms-md-note`. Content is a
//!     msgpack-encoded `NotePayload`, which carries the yrs-encoded Doc
//!     state (the CRDT source of truth) plus parent/position/tags/trash.
//!
//! On every sync we (1) bootstrap the two collections if they don't exist
//! yet, then for each kind (2) pull by stoken — apply remote items to
//! SQLite, (3) push dirty rows via `ItemManager::transaction` — and for
//! folders we always go first so notes can resolve `parent_folder_id` on
//! the way in.
//!
//! Conflict handling: if `transaction` returns `Error::Conflict`, we
//! refetch the colliding item, merge its yrs state into ours (or take
//! its non-CRDT fields if the local row is metadata-only), and retry.
//! This is the "stoken + transaction" optimistic-concurrency pattern
//! Etebase exposes; the CRDT does the actual conflict-free merging.

pub mod yrs_doc;

use std::collections::HashMap;

use chrono::Utc;
use etebase::error::Error as EtebaseError;
use etebase::managers::{CollectionManager, ItemManager};
use etebase::utils::randombytes;
use etebase::{Account, Collection, FetchOptions, Item, ItemMetadata};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::auth;
use crate::db::Db;
use crate::error::{AppError, AppResult};

const COLLECTION_TYPE_NOTES: &str = "mindstream.notes";
const COLLECTION_TYPE_FOLDERS: &str = "mindstream.folders";
const ITEM_TYPE_NOTE: &str = "ms-md-note";
const ITEM_TYPE_FOLDER: &str = "ms-md-folder";

const KIND_NOTES: &str = "notes";
const KIND_FOLDERS: &str = "folders";

const PAYLOAD_SCHEMA: u32 = 2;

/// What ends up in `Item::content` for a note. We keep our own `id`
/// (the local SQLite UUID) inside the payload so we can correlate
/// pulled items back to existing local rows even if the etebase_uid
/// hasn't been persisted yet (e.g. created on another device).
///
/// Schema versions:
///   * **1** — legacy. `yrs_state` is a `Y.Text "body"` blob (the old
///     Rust-side diff path). No `body` snapshot, no `crypto_key`. Read
///     by `apply_note` for backward compat; never written by this code.
///   * **2** — current. `yrs_state` is a y-prosemirror `XmlFragment`
///     update produced by the live editor. `body` is the rendered
///     markdown snapshot (canonical for fast local reads — Rust doesn't
///     try to render markdown from prosemirror). `crypto_key` is the
///     AES-GCM secret used by the live collab provider.
#[derive(Debug, Serialize, Deserialize)]
struct NotePayload {
    schema: u32,
    id: String,
    parent_folder_id: Option<String>,
    title: String,
    position: i64,
    tags: Vec<String>,
    /// RFC3339; None means not trashed.
    trashed_at: Option<String>,
    /// yrs-encoded Doc state — see sync/yrs_doc.rs.
    #[serde(with = "serde_bytes")]
    yrs_state: Vec<u8>,
    /// v2: rendered markdown snapshot. Default empty for legacy decode.
    #[serde(default)]
    body: String,
    /// v2: 32-byte AES-GCM key for the live collab room. Default empty
    /// for legacy decode; absence means "no live collab for this note".
    #[serde(default, with = "serde_bytes")]
    crypto_key: Vec<u8>,
    /// Favourite flag. Added without bumping the schema marker — older
    /// clients see an unknown field (rmp-serde ignores them) and newer
    /// clients reading older payloads get the serde default of `false`.
    #[serde(default)]
    favourite: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct FolderPayload {
    schema: u32,
    id: String,
    parent_folder_id: Option<String>,
    name: String,
    position: i64,
}

/// Result reported back to the UI after a sync attempt.
#[derive(Debug, Default, Serialize)]
pub struct SyncReport {
    pub folders_pulled: usize,
    pub folders_pushed: usize,
    pub notes_pulled: usize,
    pub notes_pushed: usize,
    pub conflicts_resolved: usize,
}

// ---------- Tauri command ----------

#[tauri::command]
pub async fn sync_now(app: AppHandle) -> Result<SyncReport, String> {
    let app_for_blocking = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<SyncReport, String> {
        let account = auth::try_restore(&app_for_blocking)
            .map_err(|e| format!("restore session: {e}"))?
            .ok_or_else(|| "not signed in".to_string())?;
        let db = app_for_blocking.state::<Db>();
        run(&db, &account).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("sync task: {e}"))?
}

// ---------- Top-level orchestration ----------

fn run(db: &Db, account: &Account) -> AppResult<SyncReport> {
    let mut report = SyncReport::default();
    let cm = account
        .collection_manager()
        .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;

    // Folders first so notes' parent_folder_id can resolve on pull.
    let folders_col = ensure_collection(db, &cm, KIND_FOLDERS, COLLECTION_TYPE_FOLDERS)?;
    let folders_im = cm
        .item_manager(&folders_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(folders): {e}")))?;
    pull_folders(db, &folders_im, &mut report)?;
    push_folders(db, &folders_im, &mut report)?;

    let notes_col = ensure_collection(db, &cm, KIND_NOTES, COLLECTION_TYPE_NOTES)?;
    let notes_im = cm
        .item_manager(&notes_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(notes): {e}")))?;
    pull_notes(db, &notes_im, &mut report)?;
    push_notes(db, &notes_im, &mut report)?;

    Ok(report)
}

/// Find the Etebase Collection of `collection_type` that we previously
/// created, or create one. Cached in `sync_state` so we don't re-list on
/// every sync.
fn ensure_collection(
    db: &Db,
    cm: &CollectionManager,
    kind: &str,
    collection_type: &str,
) -> AppResult<Collection> {
    let cached_uid: Option<String> = db.with_conn(|c| {
        Ok(c.query_row(
            "SELECT etebase_collection_uid FROM sync_state WHERE kind = ?1",
            params![kind],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
    })?;

    if let Some(uid) = cached_uid {
        match cm.fetch(&uid, None) {
            Ok(col) => return Ok(col),
            Err(e) => log::warn!("[sync] cached collection {uid} for {kind} unfetchable: {e}"),
        }
    }

    // Look for an existing one of the right type before creating, so two
    // installs of the same account don't end up with duplicate collections.
    let list = cm
        .list(collection_type, None)
        .map_err(|e| AppError::InvalidArg(format!("list {collection_type}: {e}")))?;
    if let Some(existing) = list.data().iter().find(|c| !c.is_deleted()) {
        let uid = existing.uid().to_string();
        save_collection_uid(db, kind, &uid)?;
        // We found it but the borrowed value is in `list`; refetch a clean
        // owned Collection via the manager so we can return it.
        let owned = cm
            .fetch(&uid, None)
            .map_err(|e| AppError::InvalidArg(format!("fetch existing {collection_type}: {e}")))?;
        return Ok(owned);
    }

    let mut meta = ItemMetadata::new();
    meta.set_name(Some(match kind {
        KIND_NOTES => "Mindstream Notes",
        KIND_FOLDERS => "Mindstream Folders",
        _ => "Mindstream",
    }))
    .set_mtime(Some(now_unix_ms()));
    let col = cm
        .create(collection_type, &meta, &[])
        .map_err(|e| AppError::InvalidArg(format!("create {collection_type}: {e}")))?;
    cm.upload(&col, None)
        .map_err(|e| AppError::InvalidArg(format!("upload {collection_type}: {e}")))?;
    save_collection_uid(db, kind, col.uid())?;
    Ok(col)
}

fn save_collection_uid(db: &Db, kind: &str, uid: &str) -> AppResult<()> {
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO sync_state (kind, etebase_collection_uid, stoken) VALUES (?1, ?2, NULL)
             ON CONFLICT(kind) DO UPDATE SET etebase_collection_uid = excluded.etebase_collection_uid",
            params![kind, uid],
        )?;
        Ok(())
    })
}

// ---------- Pull ----------

fn pull_folders(db: &Db, im: &ItemManager, report: &mut SyncReport) -> AppResult<()> {
    let stoken = load_stoken(db, KIND_FOLDERS)?;
    let mut new_stoken = stoken.clone();
    let mut iter_token: Option<String> = None;
    loop {
        let mut opts = FetchOptions::new();
        opts = opts.stoken(new_stoken.as_deref());
        if let Some(it) = &iter_token {
            opts = opts.iterator(Some(it.as_str()));
        }
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list folders: {e}")))?;
        for item in resp.data() {
            apply_folder(db, item)?;
            report.folders_pulled += 1;
        }
        new_stoken = resp.stoken().map(str::to_string).or(new_stoken);
        if resp.done() {
            break;
        }
        iter_token = None; // server uses stoken paging via response
    }
    if new_stoken != stoken {
        save_stoken(db, KIND_FOLDERS, new_stoken.as_deref())?;
    }
    Ok(())
}

fn pull_notes(db: &Db, im: &ItemManager, report: &mut SyncReport) -> AppResult<()> {
    let stoken = load_stoken(db, KIND_NOTES)?;
    let mut new_stoken = stoken.clone();
    loop {
        let mut opts = FetchOptions::new();
        opts = opts.stoken(new_stoken.as_deref());
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list notes: {e}")))?;
        for item in resp.data() {
            apply_note(db, item)?;
            report.notes_pulled += 1;
        }
        new_stoken = resp.stoken().map(str::to_string).or(new_stoken);
        if resp.done() {
            break;
        }
    }
    if new_stoken != stoken {
        save_stoken(db, KIND_NOTES, new_stoken.as_deref())?;
    }
    Ok(())
}

fn apply_folder(db: &Db, item: &Item) -> AppResult<()> {
    if item.is_deleted() {
        // Server-side delete: drop our row if we have one matched by uid.
        return db.with_conn(|c| {
            c.execute(
                "DELETE FROM collections WHERE etebase_uid = ?1",
                params![item.uid()],
            )?;
            Ok(())
        });
    }
    if item.is_missing_content() {
        return Ok(());
    }
    let raw = item
        .content()
        .map_err(|e| AppError::InvalidArg(format!("folder content: {e}")))?;
    let payload: FolderPayload = rmp_serde::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("folder msgpack: {e}")))?;
    let now = Utc::now().to_rfc3339();
    let etag = item.etag().to_string();
    db.with_conn(|c| {
        let exists: bool = c
            .query_row(
                "SELECT 1 FROM collections WHERE id = ?1",
                params![payload.id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if exists {
            c.execute(
                "UPDATE collections
                 SET parent_collection_id = ?1, name = ?2, position = ?3, modified = ?4,
                     etebase_uid = ?5, etebase_etag = ?6, dirty = 0
                 WHERE id = ?7",
                params![
                    payload.parent_folder_id,
                    payload.name,
                    payload.position,
                    now,
                    item.uid(),
                    etag,
                    payload.id,
                ],
            )?;
        } else {
            c.execute(
                "INSERT INTO collections (id, parent_collection_id, name, position,
                                           created, modified, etebase_uid, etebase_etag, dirty)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, 0)",
                params![
                    payload.id,
                    payload.parent_folder_id,
                    payload.name,
                    payload.position,
                    now,
                    item.uid(),
                    etag,
                ],
            )?;
        }
        Ok(())
    })
}

fn apply_note(db: &Db, item: &Item) -> AppResult<()> {
    if item.is_deleted() {
        return db.with_conn(|c| {
            c.execute(
                "DELETE FROM notes WHERE etebase_uid = ?1",
                params![item.uid()],
            )?;
            Ok(())
        });
    }
    if item.is_missing_content() {
        return Ok(());
    }
    let raw = item
        .content()
        .map_err(|e| AppError::InvalidArg(format!("note content: {e}")))?;
    let payload: NotePayload = rmp_serde::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("note msgpack: {e}")))?;
    let etag = item.etag().to_string();
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;

        // Existing local state, if any. We need yrs_state to merge into.
        let existing: Option<(Vec<u8>, i64, i64)> = tx
            .query_row(
                "SELECT yrs_state, dirty, payload_schema FROM notes WHERE id = ?1",
                params![payload.id],
                |r| {
                    Ok((
                        r.get::<_, Option<Vec<u8>>>(0)?.unwrap_or_default(),
                        r.get(1)?,
                        r.get(2)?,
                    ))
                },
            )
            .optional()?;

        let incoming_schema = payload.schema as i64;
        let (merged_state, dirty_after) = match existing {
            // Same-schema CRDT merge: this is the common case once both
            // devices are on the same payload version.
            Some((local_state, local_dirty, local_schema))
                if !local_state.is_empty() && local_schema == incoming_schema =>
            {
                let merged = yrs_doc::merge_remote(&local_state, &payload.yrs_state);
                // If we had unpushed local edits, the merge contains both sides —
                // keep dirty=1 so the next push uploads the merged state and lets
                // the *server* converge with anyone else's offline edits.
                (merged, local_dirty)
            }
            // Either no local state, or the schema changed under us
            // (legacy v1 row got a v2 push from another device, or vice
            // versa). Take the remote bytes wholesale — yrs can't merge
            // across formats. Local body becomes whatever the new schema
            // dictates below.
            _ => (payload.yrs_state.clone(), 0),
        };
        // For v2 payloads the remote ships the rendered markdown alongside
        // the prosemirror state — Rust can't render markdown from XmlFragment.
        // For v1 we still have the Rust-side Y.Text → markdown helper.
        let body = if payload.schema >= 2 {
            payload.body.clone()
        } else {
            yrs_doc::to_markdown(&merged_state)
        };
        let crypto_key: Option<Vec<u8>> = if payload.crypto_key.is_empty() {
            None
        } else {
            Some(payload.crypto_key.clone())
        };
        let modified = Utc::now().to_rfc3339();

        let exists = tx
            .query_row(
                "SELECT 1 FROM notes WHERE id = ?1",
                params![payload.id],
                |_| Ok(true),
            )
            .optional()?
            .is_some();
        if exists {
            tx.execute(
                "UPDATE notes
                 SET parent_collection_id = ?1, title = ?2, body = ?3, position = ?4,
                     modified = ?5, trashed_at = ?6, yrs_state = ?7,
                     etebase_uid = ?8, etebase_etag = ?9, dirty = ?10,
                     crypto_key = COALESCE(?11, crypto_key), payload_schema = ?12,
                     favourite = ?13
                 WHERE id = ?14",
                params![
                    payload.parent_folder_id,
                    payload.title,
                    body,
                    payload.position,
                    modified,
                    payload.trashed_at,
                    merged_state,
                    item.uid(),
                    etag,
                    dirty_after,
                    crypto_key,
                    incoming_schema,
                    payload.favourite as i64,
                    payload.id,
                ],
            )?;
        } else {
            tx.execute(
                "INSERT INTO notes (id, parent_collection_id, title, body, position,
                                    created, modified, trashed_at, yrs_state,
                                    etebase_uid, etebase_etag, dirty,
                                    crypto_key, payload_schema, favourite)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9, ?10, 0, ?11, ?12, ?13)",
                params![
                    payload.id,
                    payload.parent_folder_id,
                    payload.title,
                    body,
                    payload.position,
                    modified,
                    payload.trashed_at,
                    merged_state,
                    item.uid(),
                    etag,
                    crypto_key,
                    incoming_schema,
                    payload.favourite as i64,
                ],
            )?;
        }

        // Refresh tags table in one shot.
        tx.execute(
            "DELETE FROM note_tags WHERE note_id = ?1",
            params![payload.id],
        )?;
        {
            let mut stmt = tx.prepare("INSERT INTO note_tags(note_id, tag) VALUES (?1, ?2)")?;
            for tag in &payload.tags {
                stmt.execute(params![payload.id, tag])?;
            }
        }

        tx.commit()?;
        Ok(())
    })
}

// ---------- Push ----------

fn push_folders(db: &Db, im: &ItemManager, report: &mut SyncReport) -> AppResult<()> {
    let dirty = load_dirty_folders(db)?;
    if dirty.is_empty() {
        return drain_tombstones(db, im, "folder");
    }

    // Build (Item, payload, local_id) tuples for each dirty row.
    let mut prepared: Vec<(Item, String)> = Vec::with_capacity(dirty.len());
    for row in &dirty {
        let payload = FolderPayload {
            schema: PAYLOAD_SCHEMA,
            id: row.id.clone(),
            parent_folder_id: row.parent_collection_id.clone(),
            name: row.name.clone(),
            position: row.position,
        };
        let bytes = rmp_serde::to_vec_named(&payload)
            .map_err(|e| AppError::InvalidArg(format!("encode folder: {e}")))?;
        let mut meta = ItemMetadata::new();
        meta.set_item_type(Some(ITEM_TYPE_FOLDER))
            .set_name(Some(row.name.clone()))
            .set_mtime(Some(now_unix_ms()));
        let item = if let Some(uid) = &row.etebase_uid {
            let mut existing = im
                .fetch(uid, None)
                .map_err(|e| AppError::InvalidArg(format!("fetch folder {uid}: {e}")))?;
            existing
                .set_meta(&meta)
                .map_err(|e| AppError::InvalidArg(format!("set_meta folder: {e}")))?;
            existing
                .set_content(&bytes)
                .map_err(|e| AppError::InvalidArg(format!("set_content folder: {e}")))?;
            existing
        } else {
            im.create(&meta, &bytes)
                .map_err(|e| AppError::InvalidArg(format!("create folder item: {e}")))?
        };
        prepared.push((item, row.id.clone()));
    }

    let local_ids: Vec<String> = prepared.iter().map(|(_, id)| id.clone()).collect();
    let mut items: Vec<Item> = prepared.into_iter().map(|(i, _)| i).collect();
    transact_or_resolve(im, &mut items, &mut report.conflicts_resolved)
        .map_err(|e| AppError::InvalidArg(format!("transaction folders: {e}")))?;

    let pushed = items.len();
    // Persist new uids/etags + clear dirty flag.
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        for (item, local_id) in items.iter().zip(local_ids.iter()) {
            tx.execute(
                "UPDATE collections
                 SET etebase_uid = ?1, etebase_etag = ?2, dirty = 0
                 WHERE id = ?3",
                params![item.uid(), item.etag(), local_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    })?;
    report.folders_pushed += pushed;

    drain_tombstones(db, im, "folder")
}

fn push_notes(db: &Db, im: &ItemManager, report: &mut SyncReport) -> AppResult<()> {
    let dirty = load_dirty_notes(db)?;
    if dirty.is_empty() {
        return drain_tombstones(db, im, "note");
    }

    // (Item, local_id, crypto_key_to_persist). The third tuple slot is the
    // newly-generated key for notes that didn't have one yet — we write it
    // back to SQLite alongside the etag/uid in the post-transaction step
    // so the editor can pick it up immediately.
    let mut prepared: Vec<(Item, String, Option<Vec<u8>>)> = Vec::with_capacity(dirty.len());
    for row in &dirty {
        // Generate a fresh per-note collab key the first time we push it.
        // Subsequent pushes ride the same key so peers' editors stay
        // connected to the same room.
        let (key_for_payload, key_to_persist) = match &row.crypto_key {
            Some(k) if !k.is_empty() => (k.clone(), None),
            _ => {
                let k = randombytes(32);
                (k.clone(), Some(k))
            }
        };
        let payload = NotePayload {
            schema: PAYLOAD_SCHEMA,
            id: row.id.clone(),
            parent_folder_id: row.parent_collection_id.clone(),
            title: row.title.clone(),
            position: row.position,
            tags: row.tags.clone(),
            trashed_at: row.trashed_at.clone(),
            yrs_state: row.yrs_state.clone(),
            body: row.body.clone(),
            crypto_key: key_for_payload,
            favourite: row.favourite,
        };
        let bytes = rmp_serde::to_vec_named(&payload)
            .map_err(|e| AppError::InvalidArg(format!("encode note: {e}")))?;
        let mut meta = ItemMetadata::new();
        meta.set_item_type(Some(ITEM_TYPE_NOTE))
            .set_name(Some(row.title.clone()))
            .set_mtime(Some(now_unix_ms()));
        let item = if let Some(uid) = &row.etebase_uid {
            let mut existing = im
                .fetch(uid, None)
                .map_err(|e| AppError::InvalidArg(format!("fetch note {uid}: {e}")))?;
            existing
                .set_meta(&meta)
                .map_err(|e| AppError::InvalidArg(format!("set_meta note: {e}")))?;
            existing
                .set_content(&bytes)
                .map_err(|e| AppError::InvalidArg(format!("set_content note: {e}")))?;
            existing
        } else {
            im.create(&meta, &bytes)
                .map_err(|e| AppError::InvalidArg(format!("create note item: {e}")))?
        };
        prepared.push((item, row.id.clone(), key_to_persist));
    }

    // Split prepared into parallel vecs so transact_or_resolve can mutate
    // the items in-place (Item isn't Clone) while we keep the local id +
    // key-to-persist sidecars by index.
    let local_ids: Vec<String> = prepared.iter().map(|(_, id, _)| id.clone()).collect();
    let new_keys: Vec<Option<Vec<u8>>> = prepared.iter().map(|(_, _, k)| k.clone()).collect();
    let mut items: Vec<Item> = prepared.into_iter().map(|(i, _, _)| i).collect();
    transact_or_resolve(im, &mut items, &mut report.conflicts_resolved)
        .map_err(|e| AppError::InvalidArg(format!("transaction notes: {e}")))?;

    let pushed = items.len();
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        for ((item, local_id), new_key) in items.iter().zip(local_ids.iter()).zip(new_keys.iter()) {
            tx.execute(
                "UPDATE notes
                 SET etebase_uid = ?1, etebase_etag = ?2, dirty = 0,
                     crypto_key = COALESCE(?3, crypto_key),
                     payload_schema = ?4
                 WHERE id = ?5",
                params![
                    item.uid(),
                    item.etag(),
                    new_key,
                    PAYLOAD_SCHEMA as i64,
                    local_id,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    })?;
    report.notes_pushed += pushed;

    drain_tombstones(db, im, "note")
}

/// Try a transaction; on `Error::Conflict`, refetch the colliding items,
/// CRDT-merge any note bodies, and retry. Bounded retry count so a
/// pathological case doesn't loop forever.
fn transact_or_resolve(
    im: &ItemManager,
    items: &mut [Item],
    conflicts: &mut usize,
) -> Result<(), EtebaseError> {
    const MAX_ATTEMPTS: usize = 5;
    for attempt in 0..MAX_ATTEMPTS {
        let result = im.transaction(items.iter(), None);
        match result {
            Ok(()) => return Ok(()),
            Err(EtebaseError::Conflict(msg)) => {
                log::warn!(
                    "[sync] transaction conflict (attempt {}): {msg}",
                    attempt + 1
                );
                *conflicts += 1;
                refetch_and_remerge(im, items)?;
            }
            Err(e) => return Err(e),
        }
    }
    Err(EtebaseError::Conflict(
        "exceeded retry budget for transaction".into(),
    ))
}

fn refetch_and_remerge(im: &ItemManager, items: &mut [Item]) -> Result<(), EtebaseError> {
    // Fetch the latest server copy of each item we tried to push; if
    // it's a note, merge its yrs state into ours so neither side wins
    // outright. For folders, last-write-wins on the metadata is fine —
    // folders are placeholders, not user-editable content.
    for item in items.iter_mut() {
        let server = im.fetch(item.uid(), None)?;
        if server.is_deleted() || server.is_missing_content() {
            // Server has nothing newer than what we're pushing, but our
            // etag was stale. Inherit the new etag and retry.
            let bytes = item.content()?;
            let meta = item.meta()?;
            *item = im.fetch(server.uid(), None)?;
            item.set_meta(&meta)?;
            item.set_content(&bytes)?;
            continue;
        }

        let server_bytes = server.content()?;
        // Try note first; fall back to folder.
        if let Ok(server_payload) = rmp_serde::from_slice::<NotePayload>(&server_bytes) {
            let local_bytes = item.content()?;
            if let Ok(mut local_payload) = rmp_serde::from_slice::<NotePayload>(&local_bytes) {
                local_payload.yrs_state =
                    yrs_doc::merge_remote(&local_payload.yrs_state, &server_payload.yrs_state);
                let merged = rmp_serde::to_vec_named(&local_payload)
                    .map_err(|e| EtebaseError::Generic(format!("re-encode merged note: {e}")))?;
                *item = im.fetch(server.uid(), None)?;
                let local_meta = item.meta()?;
                item.set_meta(&local_meta)?;
                item.set_content(&merged)?;
                continue;
            }
        }
        // Folder (or unknown): take the local payload, ride the server etag.
        let local_bytes = item.content()?;
        let local_meta = item.meta()?;
        *item = im.fetch(server.uid(), None)?;
        item.set_meta(&local_meta)?;
        item.set_content(&local_bytes)?;
    }
    Ok(())
}

fn drain_tombstones(db: &Db, im: &ItemManager, kind: &str) -> AppResult<()> {
    let uids: Vec<String> = db.with_conn(|c| {
        let mut stmt = c.prepare("SELECT etebase_uid FROM tombstones WHERE kind = ?1")?;
        let rows = stmt.query_map(params![kind], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })?;
    if uids.is_empty() {
        return Ok(());
    }

    let mut items: Vec<Item> = Vec::with_capacity(uids.len());
    for uid in &uids {
        match im.fetch(uid, None) {
            Ok(mut item) => {
                if !item.is_deleted() {
                    item.delete()
                        .map_err(|e| AppError::InvalidArg(format!("mark deleted {uid}: {e}")))?;
                }
                items.push(item);
            }
            Err(e) => log::warn!("[sync] tombstone fetch {uid} failed: {e}"),
        }
    }

    if !items.is_empty() {
        im.transaction(items.iter(), None)
            .map_err(|e| AppError::InvalidArg(format!("transaction delete {kind}s: {e}")))?;
    }

    db.with_conn(|c| {
        let mut stmt = c.prepare("DELETE FROM tombstones WHERE kind = ?1 AND etebase_uid = ?2")?;
        for uid in &uids {
            stmt.execute(params![kind, uid])?;
        }
        Ok(())
    })?;
    Ok(())
}

// ---------- Local row reading ----------

struct DirtyFolder {
    id: String,
    parent_collection_id: Option<String>,
    name: String,
    position: i64,
    etebase_uid: Option<String>,
}

struct DirtyNote {
    id: String,
    parent_collection_id: Option<String>,
    title: String,
    position: i64,
    trashed_at: Option<String>,
    yrs_state: Vec<u8>,
    etebase_uid: Option<String>,
    tags: Vec<String>,
    /// Rendered markdown snapshot — pushed in v2 payloads so peers don't
    /// have to render markdown from XmlFragment server-side.
    body: String,
    /// Per-note collab key. None on first push; push_notes generates one.
    crypto_key: Option<Vec<u8>>,
    favourite: bool,
}

fn load_dirty_folders(db: &Db) -> AppResult<Vec<DirtyFolder>> {
    db.with_conn(|c| {
        // The 'trash' built-in is local-only; never push it.
        let mut stmt = c.prepare(
            "SELECT id, parent_collection_id, name, position, etebase_uid
             FROM collections WHERE dirty = 1 AND id <> 'trash'",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(DirtyFolder {
                id: r.get(0)?,
                parent_collection_id: r.get(1)?,
                name: r.get(2)?,
                position: r.get(3)?,
                etebase_uid: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

fn load_dirty_notes(db: &Db) -> AppResult<Vec<DirtyNote>> {
    let rows: Vec<DirtyNote> = db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT id, parent_collection_id, title, position, trashed_at,
                    yrs_state, etebase_uid, body, crypto_key, favourite
             FROM notes WHERE dirty = 1",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(DirtyNote {
                id: r.get(0)?,
                parent_collection_id: r.get(1)?,
                title: r.get(2)?,
                position: r.get(3)?,
                trashed_at: r.get(4)?,
                yrs_state: r.get::<_, Option<Vec<u8>>>(5)?.unwrap_or_default(),
                etebase_uid: r.get(6)?,
                tags: Vec::new(),
                body: r.get(7)?,
                crypto_key: r.get::<_, Option<Vec<u8>>>(8)?,
                favourite: r.get::<_, i64>(9)? != 0,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })?;

    // Hydrate tags in a second pass to keep the row mapping simple.
    let mut by_id: HashMap<String, Vec<String>> = HashMap::new();
    db.with_conn(|c| {
        let mut stmt = c.prepare("SELECT note_id, tag FROM note_tags ORDER BY tag")?;
        let mut rs = stmt.query([])?;
        while let Some(r) = rs.next()? {
            let id: String = r.get(0)?;
            let tag: String = r.get(1)?;
            by_id.entry(id).or_default().push(tag);
        }
        Ok(())
    })?;
    Ok(rows
        .into_iter()
        .map(|mut n| {
            n.tags = by_id.remove(&n.id).unwrap_or_default();
            n
        })
        .collect())
}

// ---------- sync_state helpers ----------

fn load_stoken(db: &Db, kind: &str) -> AppResult<Option<String>> {
    db.with_conn(|c| {
        Ok(c.query_row(
            "SELECT stoken FROM sync_state WHERE kind = ?1",
            params![kind],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
    })
}

fn save_stoken(db: &Db, kind: &str, stoken: Option<&str>) -> AppResult<()> {
    db.with_conn(|c| {
        c.execute(
            "UPDATE sync_state SET stoken = ?1 WHERE kind = ?2",
            params![stoken, kind],
        )?;
        Ok(())
    })
}

fn now_unix_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Room metadata the live-collab editor needs to connect. Returned by
/// `note_room_info`. `None` for the whole record means "this note can't
/// join a room yet" — typically because it hasn't been pushed to etebase
/// (no UID), or no per-note key exists locally (note was created on this
/// device and never synced).
#[derive(Debug, Serialize)]
pub struct RoomInfo {
    /// The Etebase Item UID — used as the room name across devices.
    pub room_id: String,
    /// 32-byte AES-GCM secret, base64 (URL-safe) so it survives JSON IPC
    /// without ballooning into a number array.
    pub key_b64: String,
}

#[tauri::command]
pub fn note_room_info(
    app: AppHandle,
    db: tauri::State<'_, Db>,
    id: String,
) -> Result<Option<RoomInfo>, String> {
    // Live collab is etebase-gated: no session ⇒ no room. A logged-out
    // client must not be able to join an existing room with material
    // that's still cached locally from a previous session. The logout
    // path additionally wipes `crypto_key` from the row, but this gate
    // covers the window between "session expired" and "user explicitly
    // logged out" as well.
    if !crate::auth::has_session(&app) {
        return Ok(None);
    }
    db.with_conn(|c| {
        let row: Option<(Option<String>, Option<Vec<u8>>)> = c
            .query_row(
                "SELECT etebase_uid, crypto_key FROM notes WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((Some(uid), Some(key))) = row else {
            return Ok(None);
        };
        if key.is_empty() {
            return Ok(None);
        }
        Ok(Some(RoomInfo {
            room_id: uid,
            key_b64: etebase::utils::to_base64(&key)
                .map_err(|e| AppError::InvalidArg(format!("encode key: {e}")))?,
        }))
    })
    .map_err(Into::into)
}

// Public helper used by notes/collections after a purge: queue server-side
// delete on the next sync. Caller already removed the local row.
pub fn queue_tombstone(conn: &Connection, kind: &str, etebase_uid: &str) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO tombstones (kind, etebase_uid, queued_at) VALUES (?1, ?2, ?3)",
        params![kind, etebase_uid, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}
