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

pub mod repair;
pub mod scheduler;
pub mod scopes;
pub mod tags_crdt;
pub mod yrs_doc;

use std::any::Any;
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

use chrono::Utc;
use etebase::error::Error as EtebaseError;
use etebase::managers::{CollectionManager, ItemManager};
use etebase::utils::randombytes;
use etebase::{Account, Collection, FetchOptions, Item, ItemMetadata};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::auth;
use crate::db::Db;
use crate::error::{AppError, AppResult};

const COLLECTION_TYPE_NOTES: &str = "mindstream.notes";
const COLLECTION_TYPE_FOLDERS: &str = "mindstream.folders";
const COLLECTION_TYPE_ASSETS: &str = "mindstream.assets";
const COLLECTION_TYPE_SIGNATURES: &str = "mindstream.signatures";
const ITEM_TYPE_NOTE: &str = "ms-md-note";
const ITEM_TYPE_FOLDER: &str = "ms-md-folder";
const ITEM_TYPE_ASSET: &str = "ms-md-asset";
const ITEM_TYPE_SIGNATURE: &str = "ms-md-signature";

const KIND_NOTES: &str = "notes";
const KIND_FOLDERS: &str = "folders";
const KIND_ASSETS: &str = "assets";
const KIND_SIGNATURES: &str = "signatures";

const PAYLOAD_SCHEMA: u32 = 2;

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
    #[serde(default, with = "serde_bytes")]
    tags_state: Vec<u8>,
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
    /// Editor-kind discriminator: `"markdown"` (Crepe / y-prosemirror) or
    /// `"freeform"` (drawing canvas). Added without bumping `schema` —
    /// rmp-serde-named ignores unknown fields, and older clients reading
    /// newer payloads default to "markdown" (which means they'll try to
    /// render a freeform note in the markdown editor, but won't lose any
    /// data — the yrs_state survives untouched).
    #[serde(default = "crate::notes::default_note_kind")]
    note_kind: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct FolderPayload {
    schema: u32,
    id: String,
    parent_folder_id: Option<String>,
    name: String,
    position: i64,
}

/// Wire format for a drawing-asset Etebase Item.
///
/// `id` is the same client-generated UUID the SQLite row uses and that
/// drawing records can refer to via `mindstream-asset://<id>` — stable across
/// devices. `etebase_uid` doesn't appear here because Etebase already
/// owns it (it's the Item.uid()); we only need it on the local row for
/// dirty-tracking and tombstone routing.
///
/// `owning_note_id` carries the FK back to the note so a fresh device
/// can stitch pulled assets to their drawings. If the note hasn't been
/// pulled yet (small race window between notes-pull and assets-pull),
/// apply_asset skips the row without advancing the stoken — the next
/// sync retries it once the note exists locally.
///
/// `bytes` are the raw file payload. Etebase encrypts the whole item
/// content end-to-end with the collection key, so the relay only sees
/// ciphertext — same E2EE story as notes.
#[derive(Debug, Serialize, Deserialize)]
struct AssetPayload {
    schema: u32,
    id: String,
    owning_note_id: String,
    mime_type: String,
    #[serde(with = "serde_bytes")]
    bytes: Vec<u8>,
    size: i64,
    created: String,
    modified: String,
}

/// What ends up in `Item::content` for a signature. `data` is the opaque
/// JSON geometry blob (see signatures/mod.rs); we keep our own `id` inside
/// so pulled items correlate back to local rows. Etebase E2E-encrypts the
/// whole content, same as notes/assets.
#[derive(Debug, Serialize, Deserialize)]
struct SignaturePayload {
    schema: u32,
    id: String,
    data: String,
    created: String,
    modified: String,
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
            let db = app_for_blocking.state::<Db>();
            run(&db, &account).map_err(|e| e.to_string())
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
}

fn run(db: &Db, account: &Account) -> AppResult<SyncDelta> {
    let mut delta = SyncDelta::default();
    let cm = account
        .collection_manager()
        .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;

    // Folders first so notes' parent_folder_id can resolve on pull.
    let folders_col = ensure_collection(db, &cm, KIND_FOLDERS, COLLECTION_TYPE_FOLDERS)?;
    let folders_im = cm
        .item_manager(&folders_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(folders): {e}")))?;
    pull_folders(db, &folders_im, &mut delta.report)?;
    push_folders(db, &folders_im, &mut delta.report, None)?;

    let notes_col = ensure_collection(db, &cm, KIND_NOTES, COLLECTION_TYPE_NOTES)?;
    let notes_im = cm
        .item_manager(&notes_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(notes): {e}")))?;
    pull_notes(
        db,
        &notes_im,
        &mut delta.report,
        &mut delta.notes_pulled_ids,
    )?;
    push_notes(db, &notes_im, &mut delta.report, None)?;

    // Assets last so notes — and the FK target rows they need — are
    // already in place when apply_asset tries to upsert. If a brand-new
    // remote note + its asset land in the same sync, the pull above
    // populates the note, then this pulls the asset and the FK resolves
    // cleanly. The narrow race window where a remote creates a note
    // *between* our notes pull and our assets pull is handled inside
    // apply_asset (it skips orphan assets and leaves the stoken
    // unadvanced so the next sync retries).
    let assets_col = ensure_collection(db, &cm, KIND_ASSETS, COLLECTION_TYPE_ASSETS)?;
    let assets_im = cm
        .item_manager(&assets_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(assets): {e}")))?;
    pull_assets(
        db,
        &assets_im,
        &mut delta.report,
        &mut delta.assets_pulled_ids,
    )?;
    push_assets(db, &assets_im, &mut delta.report, None)?;

    // Signatures are user-global (no FK back to notes), so order relative
    // to the others doesn't matter — apply_signature never orphans.
    let signatures_col = ensure_collection(db, &cm, KIND_SIGNATURES, COLLECTION_TYPE_SIGNATURES)?;
    let signatures_im = cm
        .item_manager(&signatures_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(signatures): {e}")))?;
    pull_signatures(db, &signatures_im, &mut delta.report)?;
    push_signatures(db, &signatures_im, &mut delta.report)?;

    // Shared scopes sync into their own per-scope collections. Isolated from
    // the vault sync above: a failure here (a malformed manifest, a scope we
    // can't reach) is logged and must never break the user's own vault sync.
    if let Err(e) = scopes::sync_scopes(db, &cm, &mut delta) {
        log::error!("[sync] scoped sync failed (vault sync unaffected): {e}");
    }

    Ok(delta)
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
        KIND_ASSETS => "Mindstream Assets",
        KIND_SIGNATURES => "Mindstream Signatures",
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
    // Outer retry handles `bad_stoken`: if the etebase server rejects
    // our cached cursor (because the user logged into a different
    // account, or the collection was rebuilt server-side), clear the
    // stoken and replay the whole pull from scratch. One retry is
    // enough — if it still fails after we've reset to None, the
    // server is unhappy about something else and we bubble it up.
    let mut already_retried = false;
    loop {
        match pull_folders_once(db, im, report) {
            Ok(()) => return Ok(()),
            Err(err) if !already_retried && is_bad_stoken_error(&err) => {
                log::warn!(
                    "[sync] bad_stoken on folders pull — resetting cursor and retrying ({err})"
                );
                save_stoken(db, KIND_FOLDERS, None)?;
                already_retried = true;
                continue;
            }
            Err(err) => return Err(err),
        }
    }
}

fn pull_folders_once(db: &Db, im: &ItemManager, report: &mut SyncReport) -> AppResult<()> {
    let stoken = load_stoken(db, KIND_FOLDERS)?;
    let mut new_stoken = stoken.clone();
    let mut iter_token: Option<String> = None;
    // Buffer of payloads we applied this pull so the repair pass below
    // can re-link any folder we had to orphan to root because its
    // parent hadn't been pulled yet. Etebase doesn't guarantee
    // parent-before-child ordering in the list response, so this is
    // the common case for nested hierarchies on a fresh install.
    let mut applied: Vec<FolderPayload> = Vec::new();
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
            match apply_folder(db, item, None) {
                Ok(Some(payload)) => applied.push(payload),
                Ok(None) => {}
                Err(err) if is_corrupt_remote_content(&err) => {
                    if mark_local_by_remote_uid_dirty(db, KIND_FOLDERS, item.uid())? {
                        log::warn!(
                            "[sync] marked local folder item {} dirty for remote repair",
                            item.uid()
                        );
                    } else {
                        log::error!(
                            "[sync] corrupt remote folder item {} has no local copy — manual recovery required",
                            item.uid()
                        );
                    }
                    log::error!(
                        "[sync] skipping corrupt remote folder item {}: {err}",
                        item.uid()
                    );
                }
                Err(err) => return Err(err),
            }
            report.folders_pulled += 1;
        }
        new_stoken = resp.stoken().map(str::to_string).or(new_stoken);
        if resp.done() {
            break;
        }
        iter_token = None; // server uses stoken paging via response
    }
    repair_folder_parents(db, &applied)?;
    if new_stoken != stoken {
        save_stoken(db, KIND_FOLDERS, new_stoken.as_deref())?;
    }
    Ok(())
}

fn pull_notes(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
    applied_ids: &mut Vec<String>,
) -> AppResult<()> {
    // Same bad_stoken self-heal pattern as pull_folders — see the
    // comment there.
    let mut already_retried = false;
    loop {
        match pull_notes_once(db, im, report, applied_ids) {
            Ok(()) => return Ok(()),
            Err(err) if !already_retried && is_bad_stoken_error(&err) => {
                log::warn!(
                    "[sync] bad_stoken on notes pull — resetting cursor and retrying ({err})"
                );
                save_stoken(db, KIND_NOTES, None)?;
                already_retried = true;
                continue;
            }
            Err(err) => return Err(err),
        }
    }
}

fn pull_notes_once(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
    applied_ids: &mut Vec<String>,
) -> AppResult<()> {
    let stoken = load_stoken(db, KIND_NOTES)?;
    let mut new_stoken = stoken.clone();
    loop {
        let mut opts = FetchOptions::new();
        opts = opts.stoken(new_stoken.as_deref());
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list notes: {e}")))?;
        for item in resp.data() {
            match apply_note(db, item, None) {
                Ok(Some(id)) => applied_ids.push(id),
                Ok(None) => {}
                Err(err) if is_corrupt_remote_content(&err) => {
                    if mark_local_by_remote_uid_dirty(db, KIND_NOTES, item.uid())? {
                        log::warn!(
                            "[sync] marked local note item {} dirty for remote repair",
                            item.uid()
                        );
                    } else {
                        log::error!(
                            "[sync] corrupt remote note item {} has no local copy — manual recovery required",
                            item.uid()
                        );
                    }
                    log::error!(
                        "[sync] skipping corrupt remote note item {}: {err}",
                        item.uid()
                    );
                }
                Err(err) => return Err(err),
            }
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

/// Pull drawing-asset items from the assets collection into local SQLite.
///
/// Mirrors pull_notes: stoken-paged iteration, apply_asset per item. The
/// one extra wrinkle is that an asset row carries a FK to its owning
/// note — if the note isn't local yet (a race window where the note was
/// created on the remote between our notes pull and this assets pull),
/// apply_asset returns "orphaned" and we set `had_orphans` so we don't
/// advance the stoken. Next sync's notes pull picks up the missing
/// note, then this re-runs from the same stoken and the previously-
/// orphaned assets land cleanly.
fn pull_assets(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
    applied_ids: &mut Vec<String>,
) -> AppResult<()> {
    // Same bad_stoken self-heal pattern as pull_folders.
    let mut already_retried = false;
    loop {
        match pull_assets_once(db, im, report, applied_ids) {
            Ok(()) => return Ok(()),
            Err(err) if !already_retried && is_bad_stoken_error(&err) => {
                log::warn!(
                    "[sync] bad_stoken on assets pull — resetting cursor and retrying ({err})"
                );
                save_stoken(db, KIND_ASSETS, None)?;
                already_retried = true;
                continue;
            }
            Err(err) => return Err(err),
        }
    }
}

fn pull_assets_once(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
    applied_ids: &mut Vec<String>,
) -> AppResult<()> {
    let stoken = load_stoken(db, KIND_ASSETS)?;
    let mut new_stoken = stoken.clone();
    let mut had_orphans = false;
    loop {
        let mut opts = FetchOptions::new();
        opts = opts.stoken(new_stoken.as_deref());
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list assets: {e}")))?;
        for item in resp.data() {
            match apply_asset(db, item, None) {
                Ok(ApplyAssetOutcome::Applied(id)) => {
                    report.assets_pulled += 1;
                    applied_ids.push(id);
                }
                Ok(ApplyAssetOutcome::Orphaned) => {
                    had_orphans = true;
                }
                Ok(ApplyAssetOutcome::Skipped) => {}
                Err(err) if is_corrupt_remote_content(&err) => {
                    if mark_local_by_remote_uid_dirty(db, KIND_ASSETS, item.uid())? {
                        log::warn!(
                            "[sync] marked local asset item {} dirty for remote repair",
                            item.uid()
                        );
                    } else {
                        log::error!(
                            "[sync] corrupt remote asset item {} has no local copy — manual recovery required",
                            item.uid()
                        );
                    }
                    log::error!(
                        "[sync] skipping corrupt remote asset item {}: {err}",
                        item.uid()
                    );
                }
                Err(err) => return Err(err),
            }
        }
        new_stoken = resp.stoken().map(str::to_string).or(new_stoken);
        if resp.done() {
            break;
        }
    }
    if !had_orphans && new_stoken != stoken {
        save_stoken(db, KIND_ASSETS, new_stoken.as_deref())?;
    }
    Ok(())
}

enum ApplyAssetOutcome {
    /// Row was written (insert or update). Carries the asset id so the
    /// caller can emit a `sync-completed` event listing what changed —
    /// open editors evict their cached blob URL and re-resolve so
    /// freshly-arrived bytes paint on the open canvas / image instead
    /// of staying broken until the user reopens the note.
    Applied(String),
    /// Asset references a note we don't have yet — keep the stoken at
    /// its previous value so the next sync retries.
    Orphaned,
    /// Delete tombstone or missing-content item — nothing to do, but no
    /// reason to pin the stoken.
    Skipped,
}

/// Apply one pulled asset item to local SQLite. Returns the outcome so
/// the caller can decide whether to advance the stoken (orphans pin it).
fn apply_asset(db: &Db, item: &Item, scope: Option<&str>) -> AppResult<ApplyAssetOutcome> {
    if item.is_deleted() {
        db.with_conn(|c| {
            c.execute(
                "DELETE FROM assets WHERE etebase_uid = ?1",
                params![item.uid()],
            )?;
            Ok(())
        })?;
        return Ok(ApplyAssetOutcome::Skipped);
    }
    if item.is_missing_content() {
        return Ok(ApplyAssetOutcome::Skipped);
    }
    let raw = item
        .content()
        .map_err(|e| AppError::InvalidArg(format!("asset content: {e}")))?;
    let payload: AssetPayload = rmp_serde::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("asset msgpack: {e}")))?;
    let etag = item.etag().to_string();
    let uid = item.uid().to_string();

    db.with_conn_mut(|c| {
        let tx = c.transaction()?;

        // FK gate: skip orphan assets rather than aborting the whole
        // pull. The orphan flag in pull_assets keeps the stoken pinned
        // so we retry on the next sync after the missing note arrives.
        let note_exists: bool = tx
            .query_row(
                "SELECT 1 FROM notes WHERE id = ?1",
                params![payload.owning_note_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !note_exists {
            log::debug!(
                "[sync] asset {} references missing note {}; deferring",
                payload.id,
                payload.owning_note_id
            );
            tx.commit()?;
            return Ok(ApplyAssetOutcome::Orphaned);
        }

        let exists = tx
            .query_row(
                "SELECT 1 FROM assets WHERE id = ?1",
                params![payload.id],
                |_| Ok(true),
            )
            .optional()?
            .is_some();

        if exists {
            // Asset rows are big blobs, not CRDTs — no merge to do.
            // Last-write-wins: take the remote bytes verbatim and
            // clear dirty so we don't immediately re-push.
            tx.execute(
                "UPDATE assets
                 SET owning_note_id = ?1, mime_type = ?2, bytes = ?3,
                     size = ?4, modified = ?5, etebase_uid = ?6,
                     etebase_etag = ?7, dirty = 0, share_scope_id = ?8
                 WHERE id = ?9",
                params![
                    payload.owning_note_id,
                    payload.mime_type,
                    payload.bytes,
                    payload.size,
                    payload.modified,
                    uid,
                    etag,
                    scope,
                    payload.id,
                ],
            )?;
        } else {
            tx.execute(
                "INSERT INTO assets(id, owning_note_id, mime_type, bytes,
                                    size, created, modified, etebase_uid,
                                    etebase_etag, dirty, share_scope_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10)",
                params![
                    payload.id,
                    payload.owning_note_id,
                    payload.mime_type,
                    payload.bytes,
                    payload.size,
                    payload.created,
                    payload.modified,
                    uid,
                    etag,
                    scope,
                ],
            )?;
        }
        tx.commit()?;
        Ok(ApplyAssetOutcome::Applied(payload.id))
    })
}

// ---------- Signatures pull ----------

fn pull_signatures(db: &Db, im: &ItemManager, report: &mut SyncReport) -> AppResult<()> {
    // Same bad_stoken self-heal pattern as pull_folders / pull_assets.
    let mut already_retried = false;
    loop {
        match pull_signatures_once(db, im, report) {
            Ok(()) => return Ok(()),
            Err(err) if !already_retried && is_bad_stoken_error(&err) => {
                log::warn!(
                    "[sync] bad_stoken on signatures pull — resetting cursor and retrying ({err})"
                );
                save_stoken(db, KIND_SIGNATURES, None)?;
                already_retried = true;
                continue;
            }
            Err(err) => return Err(err),
        }
    }
}

fn pull_signatures_once(db: &Db, im: &ItemManager, report: &mut SyncReport) -> AppResult<()> {
    let stoken = load_stoken(db, KIND_SIGNATURES)?;
    let mut new_stoken = stoken.clone();
    loop {
        let mut opts = FetchOptions::new();
        opts = opts.stoken(new_stoken.as_deref());
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list signatures: {e}")))?;
        for item in resp.data() {
            match apply_signature(db, item) {
                Ok(true) => report.signatures_pulled += 1,
                Ok(false) => {}
                Err(err) if is_corrupt_remote_content(&err) => {
                    if mark_local_by_remote_uid_dirty(db, KIND_SIGNATURES, item.uid())? {
                        log::warn!(
                            "[sync] marked local signature item {} dirty for remote repair",
                            item.uid()
                        );
                    } else {
                        log::error!(
                            "[sync] corrupt remote signature item {} has no local copy — manual recovery required",
                            item.uid()
                        );
                    }
                    log::error!(
                        "[sync] skipping corrupt remote signature item {}: {err}",
                        item.uid()
                    );
                }
                Err(err) => return Err(err),
            }
        }
        new_stoken = resp.stoken().map(str::to_string).or(new_stoken);
        if resp.done() {
            break;
        }
    }
    if new_stoken != stoken {
        save_stoken(db, KIND_SIGNATURES, new_stoken.as_deref())?;
    }
    Ok(())
}

/// Apply one pulled signature item to local SQLite. Returns `true` when a
/// row was inserted/updated (so the caller can bump the pulled counter),
/// `false` for deletes and missing-content items. No FK gate — signatures
/// are user-global, so there's nothing to orphan against.
fn apply_signature(db: &Db, item: &Item) -> AppResult<bool> {
    if item.is_deleted() {
        db.with_conn(|c| {
            c.execute(
                "DELETE FROM signatures WHERE etebase_uid = ?1",
                params![item.uid()],
            )?;
            Ok(())
        })?;
        return Ok(false);
    }
    if item.is_missing_content() {
        return Ok(false);
    }
    let raw = item
        .content()
        .map_err(|e| AppError::InvalidArg(format!("signature content: {e}")))?;
    let payload: SignaturePayload = rmp_serde::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("signature msgpack: {e}")))?;
    let etag = item.etag().to_string();
    let uid = item.uid().to_string();

    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        let exists = tx
            .query_row(
                "SELECT 1 FROM signatures WHERE id = ?1",
                params![payload.id],
                |_| Ok(true),
            )
            .optional()?
            .is_some();
        if exists {
            // Geometry blob, not a CRDT — last-write-wins on the remote copy.
            tx.execute(
                "UPDATE signatures
                 SET data = ?1, modified = ?2, etebase_uid = ?3,
                     etebase_etag = ?4, dirty = 0
                 WHERE id = ?5",
                params![payload.data, payload.modified, uid, etag, payload.id],
            )?;
        } else {
            tx.execute(
                "INSERT INTO signatures(id, data, created, modified,
                                        etebase_uid, etebase_etag, dirty)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
                params![
                    payload.id,
                    payload.data,
                    payload.created,
                    payload.modified,
                    uid,
                    etag,
                ],
            )?;
        }
        tx.commit()?;
        Ok(true)
    })
}

/// Apply one pulled folder item to the local DB.
///
/// Returns `Some(payload)` if we wrote a row (so `pull_folders` can
/// queue it for the repair pass), `None` for deletes and missing-
/// content items where there's nothing to re-link.
fn apply_folder(db: &Db, item: &Item, scope: Option<&str>) -> AppResult<Option<FolderPayload>> {
    if item.is_deleted() {
        // Server-side delete: drop our row if we have one matched by uid.
        db.with_conn(|c| {
            c.execute(
                "DELETE FROM collections WHERE etebase_uid = ?1",
                params![item.uid()],
            )?;
            Ok(())
        })?;
        return Ok(None);
    }
    if item.is_missing_content() {
        return Ok(None);
    }
    let raw = item
        .content()
        .map_err(|e| AppError::InvalidArg(format!("folder content: {e}")))?;
    let payload: FolderPayload = rmp_serde::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("folder msgpack: {e}")))?;
    let now = Utc::now().to_rfc3339();
    let etag = item.etag().to_string();
    db.with_conn(|c| {
        // Defensive: if the payload's parent folder isn't in collections
        // yet (subfolder arrived before its parent in this pull, or the
        // server orphaned it), store NULL for now. `repair_folder_parents`
        // re-links us once the parent lands later in the same pull.
        // Without this, the INSERT would hit a FOREIGN KEY violation and
        // abort the entire sync.
        let resolved_parent = resolve_parent_id(c, payload.parent_folder_id.as_deref())?;
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
                     etebase_uid = ?5, etebase_etag = ?6, dirty = 0, share_scope_id = ?7
                 WHERE id = ?8",
                params![
                    resolved_parent,
                    payload.name,
                    payload.position,
                    now,
                    item.uid(),
                    etag,
                    scope,
                    payload.id,
                ],
            )?;
        } else {
            c.execute(
                "INSERT INTO collections (id, parent_collection_id, name, position,
                                           created, modified, etebase_uid, etebase_etag, dirty,
                                           share_scope_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, 0, ?8)",
                params![
                    payload.id,
                    resolved_parent,
                    payload.name,
                    payload.position,
                    now,
                    item.uid(),
                    etag,
                    scope,
                ],
            )?;
        }
        Ok(())
    })?;
    Ok(Some(payload))
}

/// Returns the parent id unchanged if a collection with that id exists
/// locally, or `None` if it's missing — used by `apply_folder`/`apply_note`
/// during pull so a dangling `parent_folder_id` on the server doesn't
/// abort the sync with `FOREIGN KEY constraint failed`. The original
/// payload value is preserved by `pull_folders` so the repair pass can
/// reattach folders once the parent arrives.
fn resolve_parent_id(conn: &Connection, parent: Option<&str>) -> rusqlite::Result<Option<String>> {
    let Some(p) = parent else {
        return Ok(None);
    };
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM collections WHERE id = ?1",
            params![p],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if exists {
        Ok(Some(p.to_string()))
    } else {
        log::warn!("[sync] parent collection {p} not present locally; orphaning to root");
        Ok(None)
    }
}

/// After all folders in this pull have been applied, walk the buffered
/// payloads and reattach any row we had to nullify because its parent
/// wasn't yet known. We only touch rows whose parent is currently NULL
/// to avoid clobbering a user-initiated move that ran concurrently —
/// since folder upserts in this pull set parent to NULL only when the
/// parent was missing at apply time, NULL here unambiguously means
/// "we orphaned this one".
fn repair_folder_parents(db: &Db, applied: &[FolderPayload]) -> AppResult<()> {
    if applied.is_empty() {
        return Ok(());
    }
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        for p in applied {
            let Some(parent) = &p.parent_folder_id else {
                continue;
            };
            tx.execute(
                "UPDATE collections SET parent_collection_id = ?1
                 WHERE id = ?2
                   AND parent_collection_id IS NULL
                   AND EXISTS (SELECT 1 FROM collections WHERE id = ?1)",
                params![parent, p.id],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

/// Local note fields read before applying a pulled item: yrs_state + schema
/// drive the CRDT body merge, and the rest is the last-write-wins metadata we
/// must preserve when the row is locally dirty so a pull can't clobber an
/// unpushed trash / move / rename / favourite change.
struct LocalNoteState {
    yrs_state: Vec<u8>,
    dirty: i64,
    schema: i64,
    parent_collection_id: Option<String>,
    trashed_at: Option<String>,
    title: String,
    position: i64,
    favourite: i64,
    note_kind: String,
    tags_state: Vec<u8>,
}

/// Apply one pulled note item. Returns Some(note_id) when a row was
/// written (insert or update) so the caller can include it in the
/// `sync-completed` event payload — open editors merge the new
/// yrs_state into their live Y.Doc instead of going stale. Returns None
/// for deletes (no live editor to refresh) and missing-content items.
fn apply_note(db: &Db, item: &Item, scope: Option<&str>) -> AppResult<Option<String>> {
    if item.is_deleted() {
        db.with_conn(|c| {
            c.execute(
                "DELETE FROM notes WHERE etebase_uid = ?1",
                params![item.uid()],
            )?;
            Ok(())
        })?;
        return Ok(None);
    }
    if item.is_missing_content() {
        return Ok(None);
    }
    let raw = item
        .content()
        .map_err(|e| AppError::InvalidArg(format!("note content: {e}")))?;
    let payload: NotePayload = rmp_serde::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("note msgpack: {e}")))?;
    let etag = item.etag().to_string();
    apply_note_payload(db, &payload, item.uid(), &etag, scope)
}

/// Apply a decoded note payload to local SQLite. Split out from `apply_note`
/// so the local-vs-remote metadata logic can be unit-tested without
/// constructing an etebase `Item`.
fn apply_note_payload(
    db: &Db,
    payload: &NotePayload,
    uid: &str,
    etag: &str,
    scope: Option<&str>,
) -> AppResult<Option<String>> {
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;

        // Existing local row, if any. We need yrs_state + schema to merge the
        // body, plus the LWW metadata to preserve when the row is dirty.
        let existing: Option<LocalNoteState> = tx
            .query_row(
                "SELECT yrs_state, dirty, payload_schema, parent_collection_id,
                        trashed_at, title, position, favourite, note_kind, tags_state
                 FROM notes WHERE id = ?1",
                params![payload.id],
                |r| {
                    Ok(LocalNoteState {
                        yrs_state: r.get::<_, Option<Vec<u8>>>(0)?.unwrap_or_default(),
                        dirty: r.get(1)?,
                        schema: r.get(2)?,
                        parent_collection_id: r.get(3)?,
                        trashed_at: r.get(4)?,
                        title: r.get(5)?,
                        position: r.get(6)?,
                        favourite: r.get(7)?,
                        note_kind: r.get(8)?,
                        tags_state: r.get::<_, Option<Vec<u8>>>(9)?.unwrap_or_default(),
                    })
                },
            )
            .optional()?;
        let local_tags = if existing.is_some() {
            load_tags_for_note(&tx, &payload.id)?
        } else {
            Vec::new()
        };

        let incoming_schema = payload.schema as i64;
        let (merged_state, dirty_after) = match &existing {
            // Same-schema CRDT merge: this is the common case once both
            // devices are on the same payload version.
            Some(local) if !local.yrs_state.is_empty() && local.schema == incoming_schema => {
                let merged = yrs_doc::merge_remote(&local.yrs_state, &payload.yrs_state);
                // If we had unpushed local edits, the merge contains both sides —
                // keep dirty=1 so the next push uploads the merged state and lets
                // the *server* converge with anyone else's offline edits.
                (merged, local.dirty)
            }
            // Either no local state, or the schema changed under us
            // (legacy v1 row got a v2 push from another device, or vice
            // versa). Take the remote bytes wholesale — yrs can't merge
            // across formats. Local body becomes whatever the new schema
            // dictates below.
            _ => (payload.yrs_state.clone(), 0),
        };

        // Metadata (parent / trashed_at / title / position / favourite /
        // note_kind) is last-write-wins, not a CRDT. When the local row has
        // unpushed changes (dirty), a pull must NOT overwrite that metadata
        // with the remote's older copy — otherwise a note trashed (or moved /
        // renamed) locally but not yet pushed silently reverts on the next
        // pull, e.g. the full re-pull triggered by a bad_stoken reset. Keep
        // the local metadata and force dirty=1 so the next push reconciles the
        // server. The body above is still CRDT-merged regardless.
        let keep_local_meta = existing.as_ref().is_some_and(|l| l.dirty != 0);
        // For v2 payloads the remote ships the rendered markdown alongside
        // the prosemirror state — Rust can't render markdown from XmlFragment.
        // For v1 we still have the Rust-side Y.Text → markdown helper.
        let body = if payload.schema >= 2 {
            payload.body.clone()
        } else {
            yrs_doc::to_markdown(&merged_state)
        };
        // payload.crypto_key is intentionally ignored on pull — the
        // crypto_key column no longer exists locally. The editor fetches
        // the current key directly from the etebase Item each time it
        // opens a note (see note_room_info), so the server stays the
        // sole authority and nothing sensitive lands on disk.
        let modified = Utc::now().to_rfc3339();

        // Pick each metadata field from local (when dirty) or remote. For the
        // remote parent, resolve_parent_id does the defensive nullification of
        // a dangling reference (see its doc) so one bad parent can't abort the
        // pull with a FOREIGN KEY violation; a kept-local parent is already a
        // valid local id, so it needs no resolving.
        let final_parent = if keep_local_meta {
            existing
                .as_ref()
                .and_then(|l| l.parent_collection_id.clone())
        } else {
            resolve_parent_id(&tx, payload.parent_folder_id.as_deref())?
        };
        let final_title = if keep_local_meta {
            existing
                .as_ref()
                .map(|l| l.title.clone())
                .unwrap_or_default()
        } else {
            payload.title.clone()
        };
        let final_position = if keep_local_meta {
            existing.as_ref().map_or(0, |l| l.position)
        } else {
            payload.position
        };
        let final_trashed_at = if keep_local_meta {
            existing.as_ref().and_then(|l| l.trashed_at.clone())
        } else {
            payload.trashed_at.clone()
        };
        let final_favourite = if keep_local_meta {
            existing.as_ref().map_or(0, |l| l.favourite)
        } else {
            payload.favourite as i64
        };
        let final_note_kind = if keep_local_meta {
            existing
                .as_ref()
                .map(|l| l.note_kind.clone())
                .unwrap_or_default()
        } else {
            payload.note_kind.clone()
        };
        let (final_tags_state, final_tags) = match &existing {
            Some(local) => tags_crdt::merge_or_resolve(
                &local.tags_state,
                &local_tags,
                &payload.tags_state,
                &payload.tags,
                keep_local_meta,
            ),
            None => {
                tags_crdt::merge_or_resolve(&[], &[], &payload.tags_state, &payload.tags, false)
            }
        };
        // Keep dirty=1 when we preserved local metadata so the next push sends
        // it to the server; otherwise follow the body-merge's dirty decision.
        let tags_need_push = payload.tags_state.is_empty() || final_tags != payload.tags;
        let final_dirty = if keep_local_meta || tags_need_push {
            1
        } else {
            dirty_after
        };

        let exists = existing.is_some();
        if exists {
            tx.execute(
                "UPDATE notes
                 SET parent_collection_id = ?1, title = ?2, body = ?3, position = ?4,
                     modified = ?5, trashed_at = ?6, yrs_state = ?7,
                     etebase_uid = ?8, etebase_etag = ?9, dirty = ?10,
                     payload_schema = ?11, favourite = ?12, note_kind = ?13,
                     tags_state = ?14, share_scope_id = ?15
                 WHERE id = ?16",
                params![
                    final_parent,
                    final_title,
                    body,
                    final_position,
                    modified,
                    final_trashed_at,
                    merged_state,
                    uid,
                    etag,
                    final_dirty,
                    incoming_schema,
                    final_favourite,
                    final_note_kind,
                    final_tags_state,
                    scope,
                    payload.id,
                ],
            )?;
        } else {
            tx.execute(
                "INSERT INTO notes (id, parent_collection_id, title, body, position,
                                    created, modified, trashed_at, yrs_state,
                                    etebase_uid, etebase_etag, dirty,
                                    payload_schema, favourite, note_kind, tags_state,
                                    share_scope_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                params![
                    payload.id,
                    final_parent,
                    final_title,
                    body,
                    final_position,
                    modified,
                    final_trashed_at,
                    merged_state,
                    uid,
                    etag,
                    final_dirty,
                    incoming_schema,
                    final_favourite,
                    final_note_kind,
                    final_tags_state,
                    scope,
                ],
            )?;
        }

        // Refresh the query-friendly projection from the CRDT-visible tags.
        tx.execute(
            "DELETE FROM note_tags WHERE note_id = ?1",
            params![payload.id],
        )?;
        let mut stmt = tx.prepare("INSERT INTO note_tags(note_id, tag) VALUES (?1, ?2)")?;
        for tag in &final_tags {
            stmt.execute(params![payload.id, tag])?;
        }
        drop(stmt);

        tx.commit()?;
        Ok(Some(payload.id.clone()))
    })
}

// ---------- Push ----------

fn push_folders(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
    scope: Option<&str>,
) -> AppResult<()> {
    let dirty = load_dirty_folders(db, scope)?;
    if dirty.is_empty() {
        return drain_tombstones(db, im, "folder", scope);
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

    drain_tombstones(db, im, "folder", scope)
}

fn push_notes(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
    scope: Option<&str>,
) -> AppResult<()> {
    let dirty = load_dirty_notes(db, scope)?;
    if dirty.is_empty() {
        return drain_tombstones(db, im, "note", scope);
    }

    let mut prepared: Vec<(Item, String)> = Vec::with_capacity(dirty.len());
    for row in &dirty {
        // For existing items we fetch first so we can extract the live
        // crypto_key off the server-side payload and re-use it in the
        // new one. Rotating the key on every push would break peers'
        // in-progress live sessions. We'd need the fetch anyway to
        // call set_meta/set_content, so there's no extra round-trip.
        // For first-time pushes we mint a fresh key.
        let (existing_item, key_for_payload): (Option<Item>, Vec<u8>) = match &row.etebase_uid {
            Some(uid) => {
                let existing = im
                    .fetch(uid, None)
                    .map_err(|e| AppError::InvalidArg(format!("fetch note {uid}: {e}")))?;
                let extracted = if !existing.is_deleted() && !existing.is_missing_content() {
                    existing
                        .content()
                        .ok()
                        .and_then(|raw| rmp_serde::from_slice::<NotePayload>(&raw).ok())
                        .map(|p| p.crypto_key)
                        .filter(|k| !k.is_empty())
                } else {
                    None
                };
                (Some(existing), extracted.unwrap_or_else(|| randombytes(32)))
            }
            None => (None, randombytes(32)),
        };

        let payload = NotePayload {
            schema: PAYLOAD_SCHEMA,
            id: row.id.clone(),
            parent_folder_id: row.parent_collection_id.clone(),
            title: row.title.clone(),
            position: row.position,
            tags: row.tags.clone(),
            tags_state: row.tags_state.clone(),
            trashed_at: row.trashed_at.clone(),
            yrs_state: row.yrs_state.clone(),
            body: row.body.clone(),
            crypto_key: key_for_payload,
            favourite: row.favourite,
            note_kind: row.note_kind.clone(),
        };
        let bytes = rmp_serde::to_vec_named(&payload)
            .map_err(|e| AppError::InvalidArg(format!("encode note: {e}")))?;
        let mut meta = ItemMetadata::new();
        meta.set_item_type(Some(ITEM_TYPE_NOTE))
            .set_name(Some(row.title.clone()))
            .set_mtime(Some(now_unix_ms()));
        let item = if let Some(mut existing) = existing_item {
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
        prepared.push((item, row.id.clone()));
    }

    let local_ids: Vec<String> = prepared.iter().map(|(_, id)| id.clone()).collect();
    let local_tag_states: Vec<Vec<u8>> = dirty.iter().map(|row| row.tags_state.clone()).collect();
    let mut items: Vec<Item> = prepared.into_iter().map(|(i, _)| i).collect();
    transact_or_resolve(im, &mut items, &mut report.conflicts_resolved)
        .map_err(|e| AppError::InvalidArg(format!("transaction notes: {e}")))?;

    let pushed = items.len();
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        for ((item, local_id), tags_state) in items
            .iter()
            .zip(local_ids.iter())
            .zip(local_tag_states.iter())
        {
            tx.execute(
                "UPDATE notes
                 SET etebase_uid = ?1, etebase_etag = ?2, dirty = 0,
                     payload_schema = ?3, tags_state = ?4
                 WHERE id = ?5",
                params![
                    item.uid(),
                    item.etag(),
                    PAYLOAD_SCHEMA as i64,
                    tags_state,
                    local_id,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    })?;
    report.notes_pushed += pushed;

    drain_tombstones(db, im, "note", scope)
}

/// Upload dirty asset rows to the assets Etebase collection.
///
/// Mirrors push_notes but simpler: no key/encryption metadata to roll
/// over (Etebase's per-collection key handles E2EE itself), and no
/// schema flip-flop (assets have one payload version for now). After
/// the batch transaction we clear `dirty` and stamp the assigned
/// etebase_uid / etag on each local row.
///
/// Drains the asset tombstone queue at the end — entries are added by
/// notes::purge when a freeform note with synced assets gets purged.
fn push_assets(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
    scope: Option<&str>,
) -> AppResult<()> {
    let dirty = load_dirty_assets(db, scope)?;
    if dirty.is_empty() {
        return drain_tombstones(db, im, "asset", scope);
    }

    let mut prepared: Vec<(Item, String)> = Vec::with_capacity(dirty.len());
    for row in &dirty {
        let payload = AssetPayload {
            schema: 1,
            id: row.id.clone(),
            owning_note_id: row.owning_note_id.clone(),
            mime_type: row.mime_type.clone(),
            bytes: row.bytes.clone(),
            size: row.size,
            created: row.created.clone(),
            modified: row.modified.clone(),
        };
        let bytes = rmp_serde::to_vec_named(&payload)
            .map_err(|e| AppError::InvalidArg(format!("encode asset: {e}")))?;
        let mut meta = ItemMetadata::new();
        meta.set_item_type(Some(ITEM_TYPE_ASSET))
            // Asset items don't have a human-facing name; use the id
            // (matches the URL drawing records can carry) so the
            // server-side metadata is at least debuggable.
            .set_name(Some(row.id.clone()))
            .set_mtime(Some(now_unix_ms()));
        let item = if let Some(uid) = &row.etebase_uid {
            let mut existing = im
                .fetch(uid, None)
                .map_err(|e| AppError::InvalidArg(format!("fetch asset {uid}: {e}")))?;
            existing
                .set_meta(&meta)
                .map_err(|e| AppError::InvalidArg(format!("set_meta asset: {e}")))?;
            existing
                .set_content(&bytes)
                .map_err(|e| AppError::InvalidArg(format!("set_content asset: {e}")))?;
            existing
        } else {
            im.create(&meta, &bytes)
                .map_err(|e| AppError::InvalidArg(format!("create asset item: {e}")))?
        };
        prepared.push((item, row.id.clone()));
    }

    let local_ids: Vec<String> = prepared.iter().map(|(_, id)| id.clone()).collect();
    let mut items: Vec<Item> = prepared.into_iter().map(|(i, _)| i).collect();
    transact_or_resolve(im, &mut items, &mut report.conflicts_resolved)
        .map_err(|e| AppError::InvalidArg(format!("transaction assets: {e}")))?;

    let pushed = items.len();
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        for (item, local_id) in items.iter().zip(local_ids.iter()) {
            tx.execute(
                "UPDATE assets
                 SET etebase_uid = ?1, etebase_etag = ?2, dirty = 0
                 WHERE id = ?3",
                params![item.uid(), item.etag(), local_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    })?;
    report.assets_pushed += pushed;

    drain_tombstones(db, im, "asset", scope)
}

/// Push dirty signatures as per-signature items, then drain the signature
/// tombstone queue. Mirrors `push_assets` — the geometry blob is small but
/// the lifecycle (create vs fetch+set_content, etag round-trip, conflict
/// resolution) is identical.
fn push_signatures(db: &Db, im: &ItemManager, report: &mut SyncReport) -> AppResult<()> {
    let dirty = load_dirty_signatures(db)?;
    if dirty.is_empty() {
        return drain_tombstones(db, im, "signature", None);
    }

    let mut prepared: Vec<(Item, String)> = Vec::with_capacity(dirty.len());
    for row in &dirty {
        let payload = SignaturePayload {
            schema: 1,
            id: row.id.clone(),
            data: row.data.clone(),
            created: row.created.clone(),
            modified: row.modified.clone(),
        };
        let bytes = rmp_serde::to_vec_named(&payload)
            .map_err(|e| AppError::InvalidArg(format!("encode signature: {e}")))?;
        let mut meta = ItemMetadata::new();
        meta.set_item_type(Some(ITEM_TYPE_SIGNATURE))
            .set_name(Some(row.id.clone()))
            .set_mtime(Some(now_unix_ms()));
        let item = if let Some(uid) = &row.etebase_uid {
            let mut existing = im
                .fetch(uid, None)
                .map_err(|e| AppError::InvalidArg(format!("fetch signature {uid}: {e}")))?;
            existing
                .set_meta(&meta)
                .map_err(|e| AppError::InvalidArg(format!("set_meta signature: {e}")))?;
            existing
                .set_content(&bytes)
                .map_err(|e| AppError::InvalidArg(format!("set_content signature: {e}")))?;
            existing
        } else {
            im.create(&meta, &bytes)
                .map_err(|e| AppError::InvalidArg(format!("create signature item: {e}")))?
        };
        prepared.push((item, row.id.clone()));
    }

    let local_ids: Vec<String> = prepared.iter().map(|(_, id)| id.clone()).collect();
    let mut items: Vec<Item> = prepared.into_iter().map(|(i, _)| i).collect();
    transact_or_resolve(im, &mut items, &mut report.conflicts_resolved)
        .map_err(|e| AppError::InvalidArg(format!("transaction signatures: {e}")))?;

    let pushed = items.len();
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        for (item, local_id) in items.iter().zip(local_ids.iter()) {
            tx.execute(
                "UPDATE signatures
                 SET etebase_uid = ?1, etebase_etag = ?2, dirty = 0
                 WHERE id = ?3",
                params![item.uid(), item.etag(), local_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    })?;
    report.signatures_pushed += pushed;

    drain_tombstones(db, im, "signature", None)
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
                let local_tags_state = if local_payload.tags_state.is_empty() {
                    tags_crdt::init(&local_payload.tags)
                } else {
                    local_payload.tags_state.clone()
                };
                let server_tags_state = if server_payload.tags_state.is_empty() {
                    tags_crdt::init(&server_payload.tags)
                } else {
                    server_payload.tags_state
                };
                local_payload.tags_state = tags_crdt::merge(&local_tags_state, &server_tags_state);
                local_payload.tags = tags_crdt::tags(&local_payload.tags_state);
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

/// Drain queued deletes for `kind` against the collection `im` is bound to.
/// `scope` selects which tombstones belong here: `None` = the vault-wide
/// collection (`share_scope_id IS NULL`), `Some(id)` = that share scope's
/// collection. Routing by scope keeps a scoped delete from being fired at the
/// vault collection (where its uid doesn't exist) and vice versa.
fn drain_tombstones(db: &Db, im: &ItemManager, kind: &str, scope: Option<&str>) -> AppResult<()> {
    let uids: Vec<String> = db.with_conn(|c| {
        let rows = match scope {
            None => {
                let mut stmt = c.prepare(
                    "SELECT etebase_uid FROM tombstones
                     WHERE kind = ?1 AND share_scope_id IS NULL",
                )?;
                let rows = stmt.query_map(params![kind], |r| r.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            }
            Some(id) => {
                let mut stmt = c.prepare(
                    "SELECT etebase_uid FROM tombstones
                     WHERE kind = ?1 AND share_scope_id = ?2",
                )?;
                let rows = stmt.query_map(params![kind, id], |r| r.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            }
        };
        Ok(rows)
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
    favourite: bool,
    note_kind: String,
    tags_state: Vec<u8>,
}

fn load_tags_for_note(conn: &Connection, note_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT tag FROM note_tags WHERE note_id = ?1 ORDER BY tag")?;
    let rows = stmt.query_map(params![note_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn load_dirty_folders(db: &Db, scope: Option<&str>) -> AppResult<Vec<DirtyFolder>> {
    db.with_conn(|c| {
        // The 'trash' built-in is local-only; never push it. The scope
        // predicate routes each row to its home collection: a NULL `scope`
        // matches only unscoped (vault) rows, a scope id matches only that
        // scope's rows.
        let mut stmt = c.prepare(
            "SELECT id, parent_collection_id, name, position, etebase_uid
             FROM collections WHERE dirty = 1 AND id <> 'trash'
               AND ((?1 IS NULL AND share_scope_id IS NULL) OR share_scope_id = ?1)",
        )?;
        let rows = stmt.query_map(params![scope], |r| {
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

fn load_dirty_notes(db: &Db, scope: Option<&str>) -> AppResult<Vec<DirtyNote>> {
    let rows: Vec<DirtyNote> = db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT id, parent_collection_id, title, position, trashed_at,
                    yrs_state, etebase_uid, body, favourite, note_kind, tags_state
             FROM notes WHERE dirty = 1
               AND ((?1 IS NULL AND share_scope_id IS NULL) OR share_scope_id = ?1)",
        )?;
        let rows = stmt.query_map(params![scope], |r| {
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
                favourite: r.get::<_, i64>(8)? != 0,
                note_kind: r.get(9)?,
                tags_state: r.get::<_, Option<Vec<u8>>>(10)?.unwrap_or_default(),
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
            if n.tags_state.is_empty() {
                n.tags_state = tags_crdt::init(&n.tags);
            }
            n
        })
        .collect())
}

struct DirtyAsset {
    id: String,
    owning_note_id: String,
    mime_type: String,
    bytes: Vec<u8>,
    size: i64,
    created: String,
    modified: String,
    etebase_uid: Option<String>,
}

fn load_dirty_assets(db: &Db, scope: Option<&str>) -> AppResult<Vec<DirtyAsset>> {
    db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT id, owning_note_id, mime_type, bytes, size,
                    created, modified, etebase_uid
             FROM assets WHERE dirty = 1
               AND ((?1 IS NULL AND share_scope_id IS NULL) OR share_scope_id = ?1)",
        )?;
        let rows = stmt.query_map(params![scope], |r| {
            Ok(DirtyAsset {
                id: r.get(0)?,
                owning_note_id: r.get(1)?,
                mime_type: r.get(2)?,
                bytes: r.get(3)?,
                size: r.get(4)?,
                created: r.get(5)?,
                modified: r.get(6)?,
                etebase_uid: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

struct DirtySignature {
    id: String,
    data: String,
    created: String,
    modified: String,
    etebase_uid: Option<String>,
}

fn load_dirty_signatures(db: &Db) -> AppResult<Vec<DirtySignature>> {
    db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT id, data, created, modified, etebase_uid
             FROM signatures WHERE dirty = 1",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(DirtySignature {
                id: r.get(0)?,
                data: r.get(1)?,
                created: r.get(2)?,
                modified: r.get(3)?,
                etebase_uid: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
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
pub async fn note_room_info(
    app: AppHandle,
    db: tauri::State<'_, Db>,
    id: String,
) -> Result<Option<RoomInfo>, String> {
    // Live collab is etebase-gated: no session ⇒ no room.
    if !crate::auth::has_session(&app) {
        return Ok(None);
    }

    // Read just the local breadcrumbs we need: the note's item UID and
    // the cached notes-collection UID. The actual key lives only on the
    // etebase server now; we resolve it on demand below.
    let lookups = db
        .with_conn(|c| {
            let note_uid: Option<String> = c
                .query_row(
                    "SELECT etebase_uid FROM notes WHERE id = ?1",
                    params![&id],
                    |r| r.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten();
            let col_uid: Option<String> = c
                .query_row(
                    "SELECT etebase_collection_uid FROM sync_state WHERE kind = ?1",
                    params![KIND_NOTES],
                    |r| r.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten();
            Ok::<_, AppError>((note_uid, col_uid))
        })
        .map_err(|e| e.to_string())?;

    let Some(note_uid) = lookups.0 else {
        return Ok(None);
    };
    let Some(col_uid) = lookups.1 else {
        return Ok(None);
    };

    // Restore the account + fetch the item inside spawn_blocking. The
    // etebase SDK is sync-over-reqwest::blocking, which constructs a
    // private tokio runtime per call; dropping that runtime back on the
    // async worker panics — same trap as etebase_login/_logout. The
    // closure returns just the encoded key + room id so no etebase-
    // owned value escapes the blocking pool.
    let app_for_blocking = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<RoomInfo>, String> {
        catch_blocking_panic("room_info", || {
            let account = match crate::auth::try_restore(&app_for_blocking)
                .map_err(|e| format!("restore session: {e}"))?
            {
                Some(a) => a,
                None => return Ok(None),
            };
            let cm = account
                .collection_manager()
                .map_err(|e| format!("collection_manager: {e}"))?;
            let col = match cm.fetch(&col_uid, None) {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("[room_info] fetch notes collection failed: {e}");
                    return Ok(None);
                }
            };
            let im = cm
                .item_manager(&col)
                .map_err(|e| format!("item_manager: {e}"))?;
            let item = match im.fetch(&note_uid, None) {
                Ok(it) => it,
                Err(e) => {
                    log::warn!("[room_info] fetch note item {note_uid} failed: {e}");
                    return Ok(None);
                }
            };
            if item.is_deleted() || item.is_missing_content() {
                return Ok(None);
            }
            let raw = item.content().map_err(|e| format!("item content: {e}"))?;
            let payload: NotePayload = match rmp_serde::from_slice(&raw) {
                Ok(p) => p,
                Err(e) => {
                    log::warn!("[room_info] payload decode failed: {e}");
                    return Ok(None);
                }
            };
            if payload.crypto_key.is_empty() {
                // Legacy v1 payload, or a peer pushed before live collab was
                // wired up. Surface as "no room available" rather than
                // encoding zero bytes.
                return Ok(None);
            }
            Ok(Some(RoomInfo {
                room_id: note_uid,
                key_b64: etebase::utils::to_base64(&payload.crypto_key)
                    .map_err(|e| format!("encode key: {e}"))?,
            }))
        })
    })
    .await
    .map_err(|e| format!("note_room_info task: {e}"))?
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
mod tests {
    use super::*;
    use crate::db::open_memory_for_tests;

    fn remote_note(id: &str, parent: Option<&str>, trashed_at: Option<&str>) -> NotePayload {
        NotePayload {
            schema: 2,
            id: id.into(),
            parent_folder_id: parent.map(str::to_string),
            title: "Remote Title".into(),
            position: 0,
            tags: vec![],
            tags_state: vec![],
            trashed_at: trashed_at.map(str::to_string),
            yrs_state: vec![],
            body: String::new(),
            crypto_key: vec![],
            favourite: false,
            note_kind: "markdown".into(),
        }
    }

    #[test]
    fn apply_note_keeps_local_trash_when_dirty() {
        // Repro for the "notes restore themselves from trash on restart" bug:
        // a note trashed locally but not yet pushed (dirty=1, trashed_at set)
        // must not be reverted by a pull of the older, un-trashed remote copy
        // (which a bad_stoken full re-pull would feed in).
        let db = open_memory_for_tests();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO collections(id, parent_collection_id, name, position,
                                         created, modified, dirty)
                 VALUES ('coll_work', NULL, 'Work', 0, 't', 't', 0)",
                [],
            )?;
            c.execute(
                "INSERT INTO notes(id, parent_collection_id, title, body, position,
                                   created, modified, trashed_at, yrs_state,
                                   etebase_uid, etebase_etag, dirty, payload_schema,
                                   favourite, note_kind)
                 VALUES ('note_x', 'coll_work', 'Local Title', '', 0, 't', 't',
                         '2026-06-01T00:00:00Z', NULL, 'uid_x', 'etag_old', 1, 2,
                         0, 'markdown')",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        // Stale remote: not trashed, parent stripped to root.
        let remote = remote_note("note_x", None, None);
        apply_note_payload(&db, &remote, "uid_x", "etag_new", None).unwrap();

        let (trashed_at, parent, dirty, title): (Option<String>, Option<String>, i64, String) = db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT trashed_at, parent_collection_id, dirty, title
                     FROM notes WHERE id = 'note_x'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )?)
            })
            .unwrap();
        assert!(
            trashed_at.is_some(),
            "locally-trashed note must stay trashed after a pull"
        );
        assert_eq!(
            parent.as_deref(),
            Some("coll_work"),
            "local parent must be preserved, not reset to root"
        );
        assert_eq!(dirty, 1, "row stays dirty so the trash pushes next sync");
        assert_eq!(
            title, "Local Title",
            "local metadata is preserved wholesale"
        );
    }

    #[test]
    fn apply_note_takes_remote_metadata_when_clean() {
        // The flip side: a clean (non-dirty) local row must still accept the
        // remote's metadata, including a remote-side trash.
        let db = open_memory_for_tests();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO notes(id, parent_collection_id, title, body, position,
                                   created, modified, trashed_at, yrs_state,
                                   etebase_uid, etebase_etag, dirty, payload_schema,
                                   favourite, note_kind)
                 VALUES ('note_y', NULL, 'Old', '', 0, 't', 't', NULL, NULL,
                         'uid_y', 'etag_old', 0, 2, 0, 'markdown')",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        let remote = remote_note("note_y", None, Some("2026-06-10T00:00:00Z"));
        apply_note_payload(&db, &remote, "uid_y", "etag_new", None).unwrap();

        let (title, trashed_at): (String, Option<String>) = db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT title, trashed_at FROM notes WHERE id = 'note_y'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?)
            })
            .unwrap();
        assert_eq!(
            title, "Remote Title",
            "a clean local row takes remote metadata"
        );
        assert!(
            trashed_at.is_some(),
            "a remote-side trash applies to a clean local row"
        );
    }

    #[test]
    fn apply_note_merges_tag_crdts_even_when_local_metadata_is_dirty() {
        let db = open_memory_for_tests();
        let local_tags = vec!["local".to_string()];
        let local_state = tags_crdt::init(&local_tags);
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO notes(id, parent_collection_id, title, body, position,
                                   created, modified, trashed_at, yrs_state,
                                   etebase_uid, etebase_etag, dirty, payload_schema,
                                   favourite, note_kind, tags_state)
                 VALUES ('note_tags', NULL, 'Local Title', '', 0, 't', 't', NULL, NULL,
                         'uid_tags', 'etag_old', 1, 2, 0, 'markdown', ?1)",
                params![local_state],
            )?;
            c.execute(
                "INSERT INTO note_tags(note_id, tag) VALUES ('note_tags', 'local')",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        let mut remote = remote_note("note_tags", None, None);
        remote.tags = vec!["remote".into()];
        remote.tags_state = tags_crdt::init(&remote.tags);
        apply_note_payload(&db, &remote, "uid_tags", "etag_new", None).unwrap();

        let (title, dirty): (String, i64) = db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT title, dirty FROM notes WHERE id = 'note_tags'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?)
            })
            .unwrap();
        let tags = db
            .with_conn(|c| load_tags_for_note(c, "note_tags"))
            .unwrap();
        assert_eq!(title, "Local Title");
        assert_eq!(dirty, 1, "merged tags must push back to the server");
        assert_eq!(tags, vec!["local".to_string(), "remote".to_string()]);
    }

    #[test]
    fn is_bad_stoken_error_matches_etebase_sdk_message() {
        // The exact wording the etebase-rs SDK surfaces when the
        // server returns 400 Bad Request with code='bad_stoken'.
        // Reproduced from a real failure when signing back in to a
        // different etebase server with stale local cursors.
        let folders = AppError::InvalidArg(
            "list folders: HTTP error 400! Code: 'bad_stoken'. Detail: 'Invalid stoken.'".into(),
        );
        let notes = AppError::InvalidArg(
            "list notes: HTTP error 400! Code: 'bad_stoken'. Detail: 'Invalid stoken.'".into(),
        );
        let assets = AppError::InvalidArg(
            "list assets: HTTP error 400! Code: 'bad_stoken'. Detail: 'Invalid stoken.'".into(),
        );
        assert!(is_bad_stoken_error(&folders));
        assert!(is_bad_stoken_error(&notes));
        assert!(is_bad_stoken_error(&assets));
    }

    #[test]
    fn is_bad_stoken_error_rejects_unrelated_errors() {
        // Adjacent etebase errors must NOT trigger the retry — silently
        // resetting cursors on, say, a transient 401 would mask the
        // real failure and cost the user a full re-sync.
        let unauthorized = AppError::InvalidArg(
            "list folders: HTTP error 401! Code: 'unauthorized'. Detail: 'Bad token.'".into(),
        );
        let not_found = AppError::InvalidArg(
            "list notes: HTTP error 404! Code: 'not_found'. Detail: 'Collection not found.'".into(),
        );
        let bare = AppError::InvalidArg("list folders: connection refused".into());
        // Substring without the quotes (someone misspelling in a log
        // message) should not trip either.
        let prose = AppError::InvalidArg(
            "list folders: HTTP error 500! the server replied with bad stoken handling".into(),
        );
        assert!(!is_bad_stoken_error(&unauthorized));
        assert!(!is_bad_stoken_error(&not_found));
        assert!(!is_bad_stoken_error(&bare));
        assert!(!is_bad_stoken_error(&prose));
    }
}
