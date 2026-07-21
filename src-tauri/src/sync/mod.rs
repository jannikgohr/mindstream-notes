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

mod apply;
pub mod collab_room;
mod collections;
mod local_rows;
mod payloads;
mod pull;
mod push;
pub mod repair;
pub mod scheduler;
pub mod scopes;
pub mod tags_crdt;
pub mod yrs_doc;

use std::any::Any;
use std::collections::{HashMap, HashSet};
use std::panic::{catch_unwind, AssertUnwindSafe};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::Utc;
use etebase::error::Error as EtebaseError;
use etebase::managers::{CollectionManager, ItemManager};
use etebase::utils::randombytes;
use etebase::{Account, Collection, CollectionAccessLevel, FetchOptions, Item, ItemMetadata};
use hkdf::Hkdf;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::{AppHandle, Emitter, Manager};

use apply::*;
use collections::*;
use local_rows::*;
use payloads::*;
use pull::*;
use push::*;

use crate::auth;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sharing::{
    share_scope_collab_info, ShareManifest, ShareScopeCollabInfo, COLLECTION_TYPE_SHARE_MANIFEST,
};

const COLLECTION_TYPE_NOTES: &str = "mindstream.notes";
const COLLECTION_TYPE_FOLDERS: &str = "mindstream.folders";
const COLLECTION_TYPE_ASSETS: &str = "mindstream.assets";
const COLLECTION_TYPE_SIGNATURES: &str = "mindstream.signatures";
const ITEM_TYPE_NOTE: &str = "ms-md-note";
const ITEM_TYPE_FOLDER: &str = "ms-md-folder";
const ITEM_TYPE_ASSET: &str = "ms-md-asset";
const ITEM_TYPE_COLLAB_WRITER_KEY: &str = "ms-collab-writer-key";
const ITEM_TYPE_SIGNATURE: &str = "ms-md-signature";

const KIND_NOTES: &str = "notes";
const KIND_FOLDERS: &str = "folders";
const KIND_ASSETS: &str = "assets";
const KIND_SIGNATURES: &str = "signatures";

const PAYLOAD_SCHEMA: u32 = 2;
const LIVE_COLLAB_KEY_INFO: &[u8] = b"mindstream-live-collab-key/v1";
const LIVE_COLLAB_JOIN_INFO: &[u8] = b"mindstream-live-collab-join/v1";
const P256_SPKI_DER_LEN: usize = 91;
const P256_SPKI_DER_PREFIX: &[u8] = &[
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
];

pub(super) fn catch_blocking_panic<T>(
    label: &str,
    task: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    match catch_unwind(AssertUnwindSafe(task)) {
        Ok(result) => result,
        Err(payload) => {
            let message = panic_payload_to_string(payload);
            log::error!("[{label}] blocking task panicked: {message}");
            Err(format!("{label} task panicked: {message}"))
        }
    }
}

fn panic_payload_to_string(payload: Box<dyn Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "unknown panic payload".to_string()
    }
}

fn is_corrupt_remote_content(err: &AppError) -> bool {
    // Matches both the old panic-derived "out of bounds" message and the
    // current etebase-rs error wording "Chunk index out of range" returned
    // by EncryptedRevision::content() after the dedup-index fix.
    matches!(
        err,
        AppError::InvalidArg(message)
            if message.contains("content: Chunk index out of")
    )
}

/// True for the `400 bad_stoken` etebase returns when our cached
/// sync cursor refers to a state the server no longer recognises —
/// typically because the user switched accounts/servers, or because
/// the collection was rebuilt server-side. Sample error message:
///
///   list folders: HTTP error 400! Code: 'bad_stoken'. Detail: 'Invalid stoken.'
///
/// The etebase SDK packs all of this into a single string we then
/// wrap in `AppError::InvalidArg`. Matching on `'bad_stoken'` (with
/// the quotes) is precise enough to avoid colliding with unrelated
/// errors that happen to mention the substring.
fn is_bad_stoken_error(err: &AppError) -> bool {
    matches!(
        err,
        AppError::InvalidArg(message) if message.contains("'bad_stoken'")
    )
}

fn load_share_scope_part_uids(cm: &CollectionManager) -> HashSet<String> {
    let list = match cm.list(COLLECTION_TYPE_SHARE_MANIFEST, None) {
        Ok(list) => list,
        Err(e) => {
            log::warn!("[sync] could not list share manifests before vault reconcile: {e}");
            return HashSet::new();
        }
    };

    let mut uids = HashSet::new();
    for col in list.data() {
        if col.is_deleted() {
            continue;
        }
        let raw = match col.content() {
            Ok(raw) => raw,
            Err(e) => {
                log::warn!("[sync] share manifest {} content failed: {e}", col.uid());
                continue;
            }
        };
        let manifest = match serde_json::from_slice::<ShareManifest>(&raw) {
            Ok(manifest) => manifest,
            Err(e) => {
                log::warn!("[sync] share manifest {} decode failed: {e}", col.uid());
                continue;
            }
        };
        uids.extend(
            manifest
                .collections
                .into_iter()
                .map(|part| part.collection_uid),
        );
    }
    uids
}

fn mark_local_by_remote_uid_dirty(db: &Db, kind: &str, etebase_uid: &str) -> AppResult<bool> {
    let table = match kind {
        KIND_FOLDERS => "collections",
        KIND_NOTES => "notes",
        KIND_ASSETS => "assets",
        KIND_SIGNATURES => "signatures",
        _ => return Ok(false),
    };
    db.with_conn(|c| {
        let changed = c.execute(
            &format!("UPDATE {table} SET dirty = 1 WHERE etebase_uid = ?1"),
            params![etebase_uid],
        )?;
        Ok(changed > 0)
    })
}

/// Apply a server-side deletion of `etebase_uid` in `table`.
///
/// Edit-wins-over-delete: a row with unpushed local edits (`dirty = 1`) is
/// never destroyed by a remote tombstone. Instead we *detach* it — drop the
/// server identity (`etebase_uid`/`etebase_etag`) but keep the row and its
/// dirty flag — so the next push re-homes it. This makes re-home
/// non-destructive: when a shared folder's items are tombstoned out of the
/// vault and recreated in a scope, a device holding offline edits detaches its
/// vault copy here, then the scope pull reclaims that same row by stable `id`
/// and CRDT-merges the edits in (see `apply_note_payload`). It also turns a
/// genuine delete-vs-offline-edit conflict into a resurrection of the edited
/// copy rather than a silent loss. A clean row is a real delete and is removed.
///
/// `table` is always a crate-internal literal ("notes"/"collections"/
/// "assets"), never user input, so the format! is injection-safe.
fn apply_remote_delete(conn: &Connection, table: &str, etebase_uid: &str) -> AppResult<()> {
    let detached = conn.execute(
        &format!(
            "UPDATE {table} SET etebase_uid = NULL, etebase_etag = NULL
             WHERE etebase_uid = ?1 AND dirty = 1"
        ),
        params![etebase_uid],
    )?;
    if detached == 0 {
        conn.execute(
            &format!("DELETE FROM {table} WHERE etebase_uid = ?1"),
            params![etebase_uid],
        )?;
    }
    Ok(())
}

/// Result reported back to the UI after a sync attempt.
#[derive(Debug, Default, Clone, Serialize)]
pub struct SyncReport {
    pub folders_pulled: usize,
    pub folders_pushed: usize,
    pub notes_pulled: usize,
    pub notes_pushed: usize,
    pub assets_pulled: usize,
    pub assets_pushed: usize,
    pub signatures_pulled: usize,
    pub signatures_pushed: usize,
    pub conflicts_resolved: usize,
}

/// Payload of the `sync-completed` Tauri event. JS listeners use this
/// to (a) refresh the file tree, (b) merge updated yrs_state into open
/// note Y.Docs, and (c) invalidate asset blob URLs in open editors so
/// the canvas / image element re-resolves freshly-pulled bytes without
/// the user having to close and reopen the note.
///
/// Emitted on every successful sync — including no-op syncs with empty
/// id vectors — so subscribers can clear any "syncing now" indicator
/// they show.
#[derive(Debug, Default, Clone, Serialize)]
pub struct SyncCompletedEvent {
    pub report: SyncReport,
    pub notes_pulled_ids: Vec<String>,
    pub assets_pulled_ids: Vec<String>,
}

pub const SYNC_COMPLETED_EVENT: &str = "sync-completed";

/// Emitted when the pre-sync reachability probe fails — the active
/// vault's server didn't answer. The JS side turns this into a single
/// "can't reach your sync server" notification.
pub const SYNC_UNREACHABLE_EVENT: &str = "sync-unreachable";

/// Payload for [`SYNC_UNREACHABLE_EVENT`]: the server we couldn't reach
/// and the transport error detail (for logs / the notification body).
#[derive(Debug, Clone, Serialize)]
pub struct SyncUnreachableEvent {
    pub server_url: String,
    pub detail: String,
}

/// Pre-sync reachability guard shared by `sync_now` and the scheduler
/// tick. Returns `true` to proceed with the sync; `false` to skip it
/// because the active vault's server didn't answer — in which case a
/// [`SYNC_UNREACHABLE_EVENT`] has already been emitted so the UI shows
/// one clear offline notification instead of letting `run` fan out into
/// a storm of failing requests (cached-collection fetch + list × 4
/// kinds).
///
/// Signed-out installs return `true`; `run`'s `try_restore` then no-ops
/// exactly as before. An error *reading* the session (not a transport
/// failure) also returns `true`, so a genuine session problem still
/// surfaces through the normal path instead of being masked as "offline".
async fn preflight_reachable(app: &AppHandle) -> bool {
    let info = match auth::read_session_info(app) {
        Ok(Some(info)) => info,
        Ok(None) => return true,
        Err(e) => {
            log::warn!("[sync] preflight: could not read session info: {e}");
            return true;
        }
    };
    match auth::probe_server_reachable(&info.server_url).await {
        Ok(()) => true,
        Err(detail) => {
            log::warn!(
                "[sync] server unreachable, skipping sync: {} ({detail})",
                info.server_url
            );
            let event = SyncUnreachableEvent {
                server_url: info.server_url,
                detail,
            };
            if let Err(e) = app.emit(SYNC_UNREACHABLE_EVENT, &event) {
                log::warn!("[sync] failed to emit {SYNC_UNREACHABLE_EVENT}: {e}");
            }
            false
        }
    }
}

// ---------- Tauri command ----------

#[tauri::command]
pub async fn sync_now(app: AppHandle) -> Result<SyncReport, String> {
    // Acquire the scheduler's in-flight lock so manual + scheduled
    // syncs serialise instead of racing to push the same dirty rows
    // or compete for the etebase stoken. The user pays at most one
    // scheduler tick's worth of wait — typically <1s of no-op pulls.
    let scheduler_state = app.state::<scheduler::SyncScheduler>();
    let _guard = scheduler_state.acquire_in_flight().await;

    // Check the server is reachable before doing anything. On failure the
    // probe emits `sync-unreachable` (one clear offline notification);
    // bail out rather than fanning out into a storm of failing requests.
    if !preflight_reachable(&app).await {
        return Err("sync server unreachable".to_string());
    }

    let app_for_blocking = app.clone();
    let delta = tauri::async_runtime::spawn_blocking(move || -> Result<SyncDelta, String> {
        catch_blocking_panic("sync", || {
            let account = auth::try_restore(&app_for_blocking)
                .map_err(|e| format!("restore session: {e}"))?
                .ok_or_else(|| "not signed in".to_string())?;
            let self_username = auth::read_session_info(&app_for_blocking)
                .ok()
                .flatten()
                .map(|info| info.username);
            let db = app_for_blocking.state::<Db>();
            run(&db, &account, self_username.as_deref()).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| format!("sync task: {e}"))??;

    // Best-effort event emission — if no JS listeners are attached the
    // emit call is a no-op; if serialization fails (shouldn't, given
    // our derive(Serialize)) we still want the SyncReport to flow back
    // to the caller as their command result, so we just log.
    let event = SyncCompletedEvent {
        report: delta.report.clone(),
        notes_pulled_ids: delta.notes_pulled_ids,
        assets_pulled_ids: delta.assets_pulled_ids,
    };
    if let Err(err) = app.emit(SYNC_COMPLETED_EVENT, &event) {
        log::warn!("[sync] failed to emit {SYNC_COMPLETED_EVENT}: {err}");
    }
    crate::collab_events::emit_collab_credentials_changed(
        &app,
        delta.collab_credentials_changed_note_ids,
    );

    Ok(delta.report)
}

// ---------- Top-level orchestration ----------

/// Identifies what changed during a `run()` so the caller can emit a
/// `sync-completed` event that wakes open editors up to the freshness.
/// Empty vectors are common (nothing changed) and the event payload
/// callers MUST emit even on empty lists so subscribers can clear any
/// in-flight "syncing now" state.
#[derive(Debug, Default)]
pub struct SyncDelta {
    pub report: SyncReport,
    /// Note ids whose `yrs_state` was inserted or updated during pull.
    /// Open NoteEditor / FreeformNoteEditor instances merge the new
    /// state into their live Y.Doc via `Y.applyUpdate` (CRDT-safe).
    pub notes_pulled_ids: Vec<String>,
    /// Asset ids that were inserted or updated during pull. Open
    /// editors evict matching blob URLs from their AssetBridge cache
    /// and kick the corresponding image NodeView so it re-resolves.
    pub assets_pulled_ids: Vec<String>,
    /// Note ids whose live-collab room credentials changed because a
    /// share-scope manifest rotated its collab epoch/salt. Open editors
    /// reconnect their active relay clients for these notes.
    pub collab_credentials_changed_note_ids: Vec<String>,
}

fn run(db: &Db, account: &Account, self_username: Option<&str>) -> AppResult<SyncDelta> {
    let mut delta = SyncDelta::default();
    let cm = account
        .collection_manager()
        .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
    let share_scope_part_uids = load_share_scope_part_uids(&cm);

    // Item managers for the four vault collections. Set up all of them up
    // front so the sync runs in three ordered phases: pull everything, sync
    // scopes, then push everything.
    let folders_col = ensure_collection(
        db,
        &cm,
        KIND_FOLDERS,
        COLLECTION_TYPE_FOLDERS,
        &share_scope_part_uids,
    )?;
    let folders_im = cm
        .item_manager(&folders_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(folders): {e}")))?;
    let notes_col = ensure_collection(
        db,
        &cm,
        KIND_NOTES,
        COLLECTION_TYPE_NOTES,
        &share_scope_part_uids,
    )?;
    let notes_im = cm
        .item_manager(&notes_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(notes): {e}")))?;
    let assets_col = ensure_collection(
        db,
        &cm,
        KIND_ASSETS,
        COLLECTION_TYPE_ASSETS,
        &share_scope_part_uids,
    )?;
    let assets_im = cm
        .item_manager(&assets_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(assets): {e}")))?;
    let signatures_col = ensure_collection(
        db,
        &cm,
        KIND_SIGNATURES,
        COLLECTION_TYPE_SIGNATURES,
        &share_scope_part_uids,
    )?;
    let signatures_im = cm
        .item_manager(&signatures_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(signatures): {e}")))?;

    // --- Pull phase ---
    // Folders first so notes' parent_folder_id can resolve; assets last so
    // notes — and the FK target rows they need — are already in place when
    // apply_asset tries to upsert. If a brand-new remote note + its asset land
    // in the same sync, the note pull populates it, then the asset pull
    // resolves the FK cleanly. The narrow race where a remote creates a note
    // *between* our notes pull and our assets pull is handled inside
    // apply_asset (it skips orphan assets and leaves the stoken unadvanced so
    // the next sync retries). Signatures are user-global (no FK back to
    // notes), so their order doesn't matter.
    pull_folders(db, &folders_im, &mut delta.report)?;
    pull_notes(
        db,
        &notes_im,
        &mut delta.report,
        &mut delta.notes_pulled_ids,
    )?;
    pull_assets(
        db,
        &assets_im,
        &mut delta.report,
        &mut delta.assets_pulled_ids,
    )?;
    pull_signatures(db, &signatures_im, &mut delta.report)?;

    // --- Scope sync ---
    // Runs between the vault pull and the vault push on purpose. A shared
    // subtree's items are tombstoned out of the vault and recreated in a
    // scope; a device holding offline edits *detaches* its vault copy during
    // the pull above (see `apply_remote_delete`) rather than deleting it. This
    // scope sync then reclaims that row by stable `id` and stamps its scope,
    // so the vault push below skips it — without this ordering the push would
    // resurrect the detached row as an orphan vault copy. Isolated from the
    // vault sync: a failure here (malformed manifest, unreachable scope) is
    // logged and must never break the user's own vault sync.
    if let Err(e) = scopes::sync_scopes(db, &cm, &mut delta, self_username) {
        log::error!("[sync] scoped sync failed (vault sync unaffected): {e}");
    }

    // --- Push phase ---
    push_folders(db, &folders_im, &mut delta.report, None)?;
    push_notes(db, &notes_im, &mut delta.report, None)?;
    push_assets(db, &assets_im, &mut delta.report, None)?;
    push_signatures(db, &signatures_im, &mut delta.report)?;

    Ok(delta)
}

fn now_unix_ms() -> i64 {
    Utc::now().timestamp_millis()
}

// Public helper used by notes/collections after a purge: queue server-side
// delete on the next sync. Caller queues BEFORE removing the local row, so the
// row is still present here — we read its `share_scope_id` to route the delete
// to the scope's collection (or the vault-wide one when NULL). See
// `drain_tombstones`.
pub fn queue_tombstone(conn: &Connection, kind: &str, etebase_uid: &str) -> AppResult<()> {
    let share_scope_id = match kind {
        "folder" => scope_of(conn, "collections", etebase_uid)?,
        "note" => scope_of(conn, "notes", etebase_uid)?,
        "asset" => scope_of(conn, "assets", etebase_uid)?,
        _ => None,
    };
    conn.execute(
        "INSERT OR IGNORE INTO tombstones (kind, etebase_uid, queued_at, share_scope_id)
         VALUES (?1, ?2, ?3, ?4)",
        params![kind, etebase_uid, Utc::now().to_rfc3339(), share_scope_id],
    )?;
    Ok(())
}

/// Read the `share_scope_id` of the row that owns `etebase_uid` in `table`
/// (a crate-internal constant at every call site). `None` when the row is
/// already gone or unscoped.
fn scope_of(conn: &Connection, table: &str, etebase_uid: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            &format!("SELECT share_scope_id FROM {table} WHERE etebase_uid = ?1"),
            params![etebase_uid],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

#[cfg(test)]
mod tests;
