//! Etebase sync — pull/push loop for everything the local store holds.
//!
//! The vault is one Etebase Collection, `mindstream.vault`. What kind of
//! thing an item is sits in its metadata:
//!
//!   * `ms-md-folder` — content is a msgpack-encoded `FolderPayload`. No
//!     body, just placement metadata.
//!   * `ms-md-note` — content is a msgpack-encoded `NotePayload`, which
//!     carries the yrs-encoded Doc state (the CRDT source of truth) plus
//!     parent/position/tags/trash.
//!   * `ms-md-asset` — an attachment, as an `AssetPayload`.
//!   * `ms-md-signature` — a saved signature.
//!
//! On every sync we (1) find or create the collection, (2) pull by its one
//! stoken and apply remote items to SQLite in an order they can be applied
//! in, see [`pull`], then (3) push dirty rows via
//! `ItemManager::transaction`, folders first.
//!
//! Conflict handling: if `transaction` returns `Error::Conflict`, we
//! refetch the colliding item, merge its yrs state into ours (or take
//! its non-CRDT fields if the local row is metadata-only), and retry.
//! This is the "stoken + transaction" optimistic-concurrency pattern
//! Etebase exposes; the CRDT does the actual conflict-free merging.

mod apply;
mod changes;
mod claim;
pub mod collab_room;
mod collections;
pub mod feed;
pub mod limits;
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
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

use chrono::Utc;
use etebase::error::Error as EtebaseError;
use etebase::managers::{CollectionManager, ItemManager};
use etebase::utils::randombytes;
use etebase::{Account, Collection, CollectionAccessLevel, FetchOptions, Item, ItemMetadata};
use hkdf::Hkdf;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::{AppHandle, Emitter, Manager};

use apply::*;
pub(crate) use changes::forget_account_cursor;
use changes::*;
use claim::*;
use collections::*;
use limits::LimitReached;
use local_rows::*;
use payloads::*;
pub(crate) use pull::held_key;
use pull::*;
use push::*;

use crate::app_events::AppEvent;
use crate::auth;
use crate::db::Db;
use crate::error::{AppError, AppResult, CommandResult};
use crate::sharing::{share_scope_collab_info, ShareScopeCollabInfo};

/// The one collection that holds an account's own folders, notes, assets
/// and signatures.
const COLLECTION_TYPE_VAULT: &str = "mindstream.vault";
const ITEM_TYPE_NOTE: &str = "ms-md-note";
const ITEM_TYPE_FOLDER: &str = "ms-md-folder";
const ITEM_TYPE_ASSET: &str = "ms-md-asset";
const ITEM_TYPE_SIGNATURE: &str = "ms-md-signature";

/// The `sync_state` row of the vault collection: its uid and its cursor.
const KIND_VAULT: &str = "vault";
// What kind of row a tombstone or a remote uid belongs to.
const KIND_NOTES: &str = "notes";
const KIND_FOLDERS: &str = "folders";
const KIND_ASSETS: &str = "assets";
const KIND_SIGNATURES: &str = "signatures";

const PAYLOAD_SCHEMA: u32 = 2;
const LIVE_COLLAB_KEY_INFO: &[u8] = b"mindstream-live-collab-key/v1";

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

/// Last-resort message for a session that can no longer authenticate at
/// all. A merely-forgotten token does *not* reach here:
/// [`run_with_reauth`] silently mints a new one from the stored main key
/// first. This is what's left when that re-authentication is itself
/// refused — the password changed, or the user was deleted — where no
/// amount of retrying helps and only a real sign-in will do.
///
/// Says the automatic attempt already happened, so it can't be read as
/// "you should have reconnected sooner". Signing in is only ever
/// advised once the silent path has actually been tried and failed.
///
/// Safe to prescribe sign-out even though it runs
/// [`crate::auth::reset_sync_cursors`], which NULLs every `etebase_uid`:
/// signing back into the *same* server re-adopts the existing
/// collections (`ensure_collection` lists before it creates) and `run`
/// pulls before it pushes, so the pull re-attaches each uid by matching
/// our own payload id. The push then updates in place instead of
/// creating duplicates.
const SESSION_ENDED_MESSAGE: &str =
    "the server ended this device's session; sign in again to keep syncing";

/// True for the `401` etebase returns when the stored session token is
/// no longer recognised by the server — the account was logged out
/// elsewhere, the password changed, or the server's DB was rebuilt.
/// The SDK maps that response to `Error::Unauthorized(detail)` whose
/// `Display` is the bare DRF detail, so the wrapped message reads:
///
///   list mindstream.folders: Invalid token.
///
/// Unlike [`is_bad_stoken_error`] this is not self-healing: every
/// subsequent request fails the same way until the user re-authenticates.
fn is_auth_error(err: &AppError) -> bool {
    matches!(
        err,
        AppError::InvalidArg(message)
            if message.contains("Invalid token")
                || message.contains("User inactive or deleted")
    )
}

/// Stringify a [`run`] failure for the IPC boundary, translating the
/// server's opaque 401 detail into something the user can act on.
pub(crate) fn describe_run_error(err: AppError) -> String {
    if is_auth_error(&err) {
        SESSION_ENDED_MESSAGE.to_string()
    } else {
        err.to_string()
    }
}

/// Why [`run`] stopped.
pub(crate) enum RunError {
    /// The request a sync opens with did not reach the server. Nothing was
    /// pulled or pushed. Carries the transport's words.
    Unreachable(String),
    Failed(AppError),
}

impl From<AppError> for RunError {
    fn from(err: AppError) -> Self {
        Self::Failed(err)
    }
}

/// [`run`], and what follows when it could not finish for a reason that is
/// not an error to report.
///
/// `Ok(None)` is a server that could not be reached. The UI has been told,
/// see [`announce_unreachable`], and the caller remembers it so that the
/// next attempt starts with the quick probe.
///
/// A session the server has ended does not come back, and asking again on
/// a timer only repeats the refusal. So the device signs itself out, see
/// [`auth::end_session_locally`], and the UI asks the user to sign in.
/// Shared by the manual `sync_now` command and the scheduler tick so both
/// treat an ended session identically.
///
/// Blocking — the caller is already inside `spawn_blocking`.
pub(crate) fn run_session(
    app: &AppHandle,
    db: &Db,
    account: &Account,
    self_username: Option<&str>,
) -> Result<Option<SyncDelta>, String> {
    match run(db, account, self_username) {
        Ok(delta) => Ok(Some(delta)),
        Err(RunError::Unreachable(detail)) => {
            let server_url = auth::read_session_info(app)
                .ok()
                .flatten()
                .map(|info| info.server_url)
                .unwrap_or_default();
            announce_unreachable(app, server_url, detail);
            Ok(None)
        }
        Err(RunError::Failed(err)) => {
            if is_auth_error(&err) {
                log::warn!("[sync] the server rejected this device's session: {err}");
                auth::end_session_locally(app);
            }
            Err(describe_run_error(err))
        }
    }
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
    /// The spaces the server took nothing new for, see [`LimitReached`].
    /// Empty when everything went up, which is also what takes an earlier
    /// notice away.
    pub limits: Vec<LimitReached>,
}

/// Emitted when the pre-sync reachability probe fails — the active
/// vault's server didn't answer. The JS side turns this into a single
/// "can't reach your sync server" notification.
/// Payload for [`AppEvent::SyncUnreachable`]: the server we couldn't reach
/// and the transport error detail (for logs / the notification body).
#[derive(Debug, Clone, Serialize)]
pub struct SyncUnreachableEvent {
    pub server_url: String,
    pub detail: String,
}

/// Tell the UI the sync server did not answer. It shows one clear offline
/// notification for it.
fn announce_unreachable(app: &AppHandle, server_url: String, detail: String) {
    log::warn!("[sync] server unreachable, skipping sync: {server_url} ({detail})");
    let event = SyncUnreachableEvent { server_url, detail };
    let event_name = AppEvent::SyncUnreachable.as_str();
    if let Err(e) = app.emit(event_name, &event) {
        log::warn!("[sync] failed to emit {event_name}: {e}");
    }
}

/// Reachability guard for a sync that does not know whether the server is
/// there: the first of a run, and any that follows one that could not
/// reach it. Returns `true` to proceed with the sync; `false` to skip it
/// because the active vault's server didn't answer, in which case
/// [`announce_unreachable`] has told the UI.
///
/// The probe is small and gives up after a few seconds, where a sync's own
/// requests wait much longer. So while the server is away, each tick costs
/// one short question. Once a sync has gone through, the next ones skip
/// the probe: the request a sync opens with finds out just as well, see
/// [`RunError::Unreachable`], and an idle sync is then that one request.
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
            announce_unreachable(app, info.server_url, detail);
            false
        }
    }
}

// ---------- Tauri command ----------

#[tauri::command]
pub async fn sync_now(app: AppHandle) -> CommandResult<SyncReport> {
    // Acquire the scheduler's in-flight lock so manual + scheduled
    // syncs serialise instead of racing to push the same dirty rows
    // or compete for the etebase stoken. The user pays at most one
    // scheduler tick's worth of wait — typically <1s of no-op pulls.
    let scheduler_state = app.state::<scheduler::SyncScheduler>();
    let _guard = scheduler_state.acquire_in_flight().await;

    // While it is not known that the server is there, ask with the quick
    // probe first. On failure it emits `sync-unreachable` (one clear
    // offline notification); bail out rather than wait on a sync's own
    // slower requests.
    if !scheduler_state.server_reached() && !preflight_reachable(&app).await {
        return Err("sync server unreachable".into());
    }

    let app_for_blocking = app.clone();
    let delta =
        tauri::async_runtime::spawn_blocking(move || -> Result<Option<SyncDelta>, String> {
            catch_blocking_panic("sync", || {
                let account = auth::try_restore(&app_for_blocking)
                    .map_err(|e| format!("restore session: {e}"))?
                    .ok_or_else(|| "not signed in".to_string())?;
                let self_username = auth::read_session_info(&app_for_blocking)
                    .ok()
                    .flatten()
                    .map(|info| info.username);
                let db = app_for_blocking.state::<Db>();
                run_session(&app_for_blocking, &db, &account, self_username.as_deref())
            })
        })
        .await
        .map_err(|e| format!("sync task: {e}"))??;
    scheduler_state.set_server_reached(delta.is_some());
    let Some(delta) = delta else {
        return Err("sync server unreachable".into());
    };

    // Best-effort event emission — if no JS listeners are attached the
    // emit call is a no-op; if serialization fails (shouldn't, given
    // our derive(Serialize)) we still want the SyncReport to flow back
    // to the caller as their command result, so we just log.
    let event = SyncCompletedEvent {
        report: delta.report.clone(),
        notes_pulled_ids: delta.notes_pulled_ids,
        assets_pulled_ids: delta.assets_pulled_ids,
        limits: delta.limits,
    };
    let event_name = AppEvent::SyncCompleted.as_str();
    if let Err(err) = app.emit(event_name, &event) {
        log::warn!("[sync] failed to emit {event_name}: {err}");
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
    /// The spaces whose push the server refused for a limit. Their rows
    /// stay dirty and go up with the first sync that has room.
    pub limits: Vec<LimitReached>,
}

/// The vault's collection, when this sync visits the vault: the server
/// changed it, this device has something to send to it, or the device has
/// not settled on a vault collection yet. `None` when it is left alone.
fn open_vault(db: &Db, cm: &CollectionManager, changes: &Changes) -> AppResult<Option<Collection>> {
    let (cached_uid, passes_left) = load_collection_state(db, KIND_VAULT)?;
    let settled = cached_uid.is_some() && passes_left == 0;
    // Any vault collection in the answer counts, the one in use or another.
    // A second one is what `ensure_collection` exists to sort out.
    let changed = !changes.vault.is_empty();
    if !visits_vault(changes.full, settled, changed, vault_has_local_work(db)?) {
        return Ok(None);
    }
    ensure_collection(db, cm, KIND_VAULT, COLLECTION_TYPE_VAULT, &changes.vault).map(Some)
}

fn run(db: &Db, account: &Account, self_username: Option<&str>) -> Result<SyncDelta, RunError> {
    let mut delta = SyncDelta::default();
    let cm = account
        .collection_manager()
        .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;

    // One request says which spaces changed since the last sync. A space
    // that did not, and that this device has nothing to send to, is not
    // visited. When that is every space, the sync ends here.
    let changes = account_changes(db, &cm)?;

    let vault_im = match open_vault(db, &cm, &changes)? {
        Some(vault_col) => Some(
            cm.item_manager(&vault_col)
                .map_err(|e| AppError::InvalidArg(format!("item_manager(vault): {e}")))?,
        ),
        None => None,
    };

    // --- Pull phase ---
    // Every space that is visited is pulled before anything is pushed, the
    // ones with only something to send included. A shared subtree's
    // items are tombstoned out of the vault and recreated in a scope; a
    // device holding offline edits *detaches* its vault copy during the
    // vault pull (see `apply_remote_delete`) rather than deleting it. The
    // scope's pull then reclaims that row by stable `id` and stamps its
    // scope, so the vault push below skips it. Pushed any earlier, the
    // detached row would go back up as an orphan vault copy.
    //
    // One stream for every kind. `pull_space` sees to it that a folder is
    // applied before the notes in it and a note before its assets.
    let vault = SpacePull {
        scope: None,
        stoken_key: KIND_VAULT,
        preserve_dirty_local_edits: true,
    };
    let mut held: Vec<Held> = Vec::new();
    if let Some(vault_im) = &vault_im {
        held.extend(pull_space(db, vault_im, &vault, &mut delta)?);
    }

    // The shared folders are kept apart from the vault's sync: a failure
    // there (a manifest that does not decode, a folder that cannot be
    // fetched) is logged and must never stop the user's own notes from
    // syncing.
    let shared = match scopes::pull_scopes(db, &cm, &changes, &mut delta, self_username, &mut held)
    {
        Ok(shared) => shared,
        Err(e) => {
            log::error!("[sync] shared folders not synced (vault sync unaffected): {e}");
            scopes::PulledScopes {
                open: Vec::new(),
                complete: false,
            }
        }
    };

    // Items whose row was still at home in another space when they came.
    // Every space has been pulled now, so a row that was moving has been
    // let go by the space it left.
    settle_held(db, held, &mut delta)?;

    // --- Push phase ---
    // Deletions first, in every space, and only then what is new. A row
    // that moves from one space to another is a deletion in the first and a
    // creation in the second. In this order no device ever finds it in
    // both, which is what lets a pull refuse an item whose row is at home
    // somewhere else (see `claim`).
    if let Some(vault_im) = &vault_im {
        for kind in ["folder", "note", "asset"] {
            drain_tombstones(db, vault_im, kind, None)?;
        }
    }
    scopes::drain_scope_tombstones(db, &shared.open);
    scopes::push_scopes(db, &cm, &shared.open, &mut delta);

    if let Some(vault_im) = &vault_im {
        if let Err(err) = push_vault(db, vault_im, &mut delta.report) {
            // A full vault is not a sync that failed. Everything was
            // pulled, the shared folders were pushed, and what could not go
            // up waits where it is. The user is told which limit it was.
            let Some(reason) = err.limit() else {
                return Err(err.into());
            };
            log::warn!("[sync] the server took nothing new for the vault: {err}");
            delta.limits.push(LimitReached::in_vault(reason));
        }
    }

    // The account's cursor moves last, and only when everything the list
    // named was applied. A folder that failed, or a space still waiting for
    // a row to be let go, has not moved its own cursor. Keeping this one
    // back makes the next sync hear of the same spaces again.
    //
    // What this sync pushed is past the cursor, so the next sync is told
    // those spaces changed and pulls its own changes back once.
    if shared.complete && !holds_remain(db)? {
        save_stoken(db, KIND_ACCOUNT, changes.stoken.as_deref())?;
    }

    Ok(delta)
}

/// Push what changed locally in the vault.
fn push_vault(db: &Db, im: &ItemManager, report: &mut SyncReport) -> AppResult<()> {
    // Folders first, so that no device ever pulls a note whose folder the
    // server has not been told about.
    push_folders(db, im, report, None)?;
    push_notes(db, im, report, None)?;
    push_assets(db, im, report, None)?;
    push_signatures(db, im, report)
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
