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

pub mod collab_room;
mod local_rows;
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

use local_rows::*;
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
    /// Canonical note creation timestamp. Added after schema 2; older
    /// payloads default to None and fall back to the local row / pull time.
    #[serde(default)]
    created: Option<String>,
    /// Canonical note modification timestamp. Added after schema 2; older
    /// payloads default to None and fall back to the local row / pull time.
    #[serde(default)]
    modified: Option<String>,
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
    #[serde(default)]
    created: Option<String>,
    #[serde(default)]
    modified: Option<String>,
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

/// Public signing key a writable shared-folder member publishes into the
/// scope's encrypted assets collection. It authorizes live-collab write frames
/// for one collab epoch; rotating the epoch naturally retires old keys.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct CollabWriterKeyPayload {
    schema: u32,
    share_scope_id: String,
    collab_epoch: u64,
    public_key_b64: String,
    username: Option<String>,
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

/// How many consecutive stable syncs (winner == cached) we require before
/// disarming the reconcile window and reverting to the cache fast path. Each
/// create/migrate re-arms to this value. Three passes at the "live" 30s
/// cadence is ~90s — comfortably longer than the concurrent first-sync window
/// where two fresh devices could otherwise cement a split-brain.
const RECONCILE_PASSES: i64 = 3;

/// Find the Etebase Collection of `collection_type` that we previously
/// created, or create one, keeping the account's devices converged on a
/// single collection per singleton `kind`.
///
/// Cache-first once *disarmed*: a cached uid that still fetches is returned
/// without listing, so steady-state sync stays cheap.
///
/// While *armed* (`reconcile_passes_left > 0`) — the window after any
/// create/migrate, and the few syncs after this migration lands — we list the
/// account's collections of this type and converge on the lexicographically
/// smallest live uid. That min is a deterministic winner every device computes
/// identically, so two fresh devices that each created their own collection in
/// the first-sync race both adopt the same one; the loser migrates its rows
/// over (see `switch_to_collection`) and the abandoned collection is simply
/// left orphaned server-side. A stable pass decrements the counter; reaching
/// zero disarms.
fn ensure_collection(
    db: &Db,
    cm: &CollectionManager,
    kind: &str,
    collection_type: &str,
    share_scope_part_uids: &HashSet<String>,
) -> AppResult<Collection> {
    let (cached_uid, passes_left) = load_collection_state(db, kind)?;

    // Disarmed fast path: trust the cache exactly like before. Only fall
    // through to the (re)listing path if the cached collection can't be
    // fetched — a cache miss must not silently mint a duplicate.
    if passes_left == 0 {
        if let Some(uid) = &cached_uid {
            match cm.fetch(uid, None) {
                Ok(col) => {
                    let candidate = VaultCollectionCandidate::from(&col);
                    if usable_vault_collection(&candidate, share_scope_part_uids) {
                        return Ok(col);
                    }
                    log::warn!(
                        "[sync] cached collection {} for {kind} is not usable as a vault singleton; reconciling",
                        col.uid()
                    );
                }
                Err(e) => log::warn!("[sync] cached collection {uid} for {kind} unfetchable: {e}"),
            }
        }
    }

    let list = cm
        .list(collection_type, None)
        .map_err(|e| AppError::InvalidArg(format!("list {collection_type}: {e}")))?;
    let winner_uid = list
        .data()
        .iter()
        .map(VaultCollectionCandidate::from)
        .filter(|candidate| usable_vault_collection(candidate, share_scope_part_uids))
        .map(|candidate| candidate.uid.to_string())
        .min();

    if let Some(winner) = winner_uid {
        if cached_uid.as_deref() == Some(winner.as_str()) {
            // Stable this pass — count down toward disarm.
            set_reconcile_passes(db, kind, passes_left.saturating_sub(1))?;
        } else {
            // Adopt/migrate onto the winner and re-arm the window. On a fresh
            // device this is the harmless "adopt existing" case (rows are
            // already dirty with NULL item uids); on a loser it re-homes rows
            // off the duplicate collection.
            switch_to_collection(db, kind, &winner)?;
        }
        return cm
            .fetch(&winner, None)
            .map_err(|e| AppError::InvalidArg(format!("fetch {collection_type}: {e}")));
    }

    // None exist yet — create, upload, arm the window.
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

/// Read the cached collection uid and remaining reconcile passes for `kind`.
/// A missing row means "never synced this kind" → armed (RECONCILE_PASSES) so
/// the first sync goes through the listing/converge path.
fn load_collection_state(db: &Db, kind: &str) -> AppResult<(Option<String>, i64)> {
    db.with_conn(|c| {
        Ok(c.query_row(
            "SELECT etebase_collection_uid, reconcile_passes_left
             FROM sync_state WHERE kind = ?1",
            params![kind],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?)),
        )
        .optional()?
        .unwrap_or((None, RECONCILE_PASSES)))
    })
}

fn set_reconcile_passes(db: &Db, kind: &str, passes: i64) -> AppResult<()> {
    db.with_conn(|c| {
        c.execute(
            "UPDATE sync_state SET reconcile_passes_left = ?1 WHERE kind = ?2",
            params![passes, kind],
        )?;
        Ok(())
    })
}

/// Point `kind`'s cache at a newly created collection and arm the reconcile
/// window. Resets stoken because a new collection uid invalidates the old
/// pull cursor.
fn save_collection_uid(db: &Db, kind: &str, uid: &str) -> AppResult<()> {
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO sync_state (kind, etebase_collection_uid, stoken, reconcile_passes_left)
             VALUES (?1, ?2, NULL, ?3)
             ON CONFLICT(kind) DO UPDATE SET
                etebase_collection_uid = excluded.etebase_collection_uid,
                stoken = NULL,
                reconcile_passes_left = excluded.reconcile_passes_left",
            params![kind, uid, RECONCILE_PASSES],
        )?;
        Ok(())
    })
}

/// Migrate this device onto the reconcile winner for `kind`. Points the cache
/// at `winner_uid`, clears the stale pull cursor, re-arms the window, and
/// routes every vault row of this kind back through push's create path against
/// the winner by clearing its old collection-scoped item uid/etag and marking
/// it dirty. The winner already holds the surviving copies; rows converge by
/// their stable app id on the next pull, and rows only this device had are
/// re-created in the winner. Scoped (shared) rows keep their own routing and
/// the local-only 'trash' folder is never pushed.
fn switch_to_collection(db: &Db, kind: &str, winner_uid: &str) -> AppResult<()> {
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO sync_state (kind, etebase_collection_uid, stoken, reconcile_passes_left)
             VALUES (?1, ?2, NULL, ?3)
             ON CONFLICT(kind) DO UPDATE SET
                etebase_collection_uid = excluded.etebase_collection_uid,
                stoken = NULL,
                reconcile_passes_left = excluded.reconcile_passes_left",
            params![kind, winner_uid, RECONCILE_PASSES],
        )?;
        let sql = match kind {
            KIND_NOTES => {
                "UPDATE notes SET dirty = 1, etebase_uid = NULL, etebase_etag = NULL
                 WHERE share_scope_id IS NULL"
            }
            KIND_FOLDERS => {
                "UPDATE collections SET dirty = 1, etebase_uid = NULL, etebase_etag = NULL
                 WHERE share_scope_id IS NULL AND id != 'trash'"
            }
            KIND_ASSETS => {
                "UPDATE assets SET dirty = 1, etebase_uid = NULL, etebase_etag = NULL
                 WHERE share_scope_id IS NULL"
            }
            KIND_SIGNATURES => {
                "UPDATE signatures SET dirty = 1, etebase_uid = NULL, etebase_etag = NULL"
            }
            _ => return Ok(()),
        };
        c.execute(sql, [])?;
        Ok(())
    })?;
    log::info!("[sync] {kind} reconciled onto collection {winner_uid}");
    Ok(())
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
