//! Auto-save worker thread for ink notes.
//!
//! ## Why this lives on its own thread
//!
//! Before this module, the native-render save flow was:
//!
//!   render thread → emit "drawing:dirty" Tauri event → JS → 800 ms
//!   setTimeout → drawingGetState (Tauri command, returns Vec<u8>
//!   via JSON-encoded IPC) → saveNote (Tauri command, takes
//!   Vec<u8> via JSON-encoded IPC) → SQLite write
//!
//! Two full IPC round-trips per save, each carrying the entire yrs
//! blob through JSON serialisation. Slow for heavy notes; also
//! creates a window where the render thread had to encode the doc
//! synchronously to serve the get_state IPC even if it was busy
//! processing pen samples.
//!
//! Now:
//!
//!   render thread → notify_dirty → channel send to this worker
//!   thread → debounce → ask render thread for bytes once (via the
//!   existing internal mpsc, NOT IPC) → write directly to SQLite
//!   in-process.
//!
//! Bytes never cross IPC. JS is only kept in the loop via small
//! `drawing:save_status` events (`{note_id, status}`) for the
//! dockview saving-icon — those are tiny and cheap.
//!
//! ## Threading model
//!
//! - One long-lived worker thread (spawned in [`init`] at app
//!   startup).
//! - Owns `HashMap<note_id, last_dirty_instant>` and the current
//!   `debounce_ms`. Both live entirely on the worker; no locks.
//! - Receives [`SaveMsg`] over an mpsc channel. `recv_timeout`
//!   blocks until either a new message arrives or the next pending
//!   save's deadline elapses, whichever is sooner.
//! - On deadline in the legacy desktop renderer: emit "saving", ask
//!   the render thread for bytes (bounded 500 ms call via
//!   `render::get_state_for_note`), write to SQLite via
//!   `notes::save_yrs_state`, emit saved / error.
//!
//! Android's current JS-canvas editor saves through
//! `drawing_save_ink_state` directly, so this worker is a benign
//! no-op there.
//!
//! Crucially, the render thread is never blocked by this worker.
//! `notify_dirty` is a non-blocking channel send. `GetStateForNote`
//! is processed when the render thread gets to it in its normal
//! batch — which means during active drawing, the worker may wait
//! a few ms for the response. That's fine: by the time the worker's
//! deadline fires, the user has paused for `debounce_ms` (~800 ms
//! default) and the render thread is idle.

use std::collections::HashMap;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::Db;
use crate::notes;

/// Default debounce window before a "dirty" stroke document gets
/// written to disk. Matches the old JS-side `SAVE_DEBOUNCE_MS` so
/// behaviour is unchanged out of the box; JS can override via the
/// `drawing_set_save_debounce` Tauri command.
const DEFAULT_DEBOUNCE_MS: u64 = 800;

/// Upper bound on how long `recv_timeout` blocks when there's
/// nothing pending. Just a defensive long sleep — short enough that
/// a future "shutdown" message would be handled within a few
/// seconds at worst.
const IDLE_SLEEP: Duration = Duration::from_secs(60);

/// Name of the per-note save-state event the worker emits to JS.
/// Payload is a [`SaveStatusEvent`]; `DrawingNoteEditor.svelte`
/// subscribes and mirrors into the global note-status store so the
/// dockview saving-icon reflects live state.
pub const SAVE_STATUS_EVENT: &str = "drawing:save_status";

/// Messages the worker accepts.
enum SaveMsg {
    /// Stroke document mutated — reset the debounce timer.
    Dirty(String),
    /// User changed the auto-save debounce setting.
    SetDebounce(u64),
    /// Flush every pending save immediately (e.g., user navigated
    /// away from the note). Effectively "expire all deadlines now".
    FlushAll,
}

/// Save-state lifecycle for one note, serialised into the
/// `drawing:save_status` Tauri event.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "snake_case")]
enum SaveStatus {
    /// Stroke document just mutated; nothing written yet. The
    /// debounce timer is running. JS shows the "pending" icon.
    Editing,
    /// Worker started the SQLite write. Usually quick (a few ms).
    Saving,
    /// SQLite write completed successfully.
    Saved,
    /// SQLite write (or the get-state round-trip) failed. JS shows
    /// the error icon and logs the message; the next dirty event
    /// kicks off another save attempt.
    Error,
}

#[derive(Serialize, Clone, Debug)]
struct SaveStatusEvent {
    note_id: String,
    status: SaveStatus,
}

/// Channel handle to the running save worker. Populated by [`init`];
/// `None` before init runs (defensive — `notify_dirty` no-ops if
/// init hasn't fired yet, e.g. during very-early-boot dirty events
/// from a startup sync).
static WORKER_TX: OnceLock<Sender<SaveMsg>> = OnceLock::new();

/// Spawn the worker thread + stash its channel sender. Called from
/// `drawing::init` at app startup. Idempotent: second call no-ops
/// because the OnceLock is already populated.
pub fn init(app: AppHandle) {
    let (tx, rx) = mpsc::channel::<SaveMsg>();
    if WORKER_TX.set(tx).is_err() {
        log::warn!("[drawing.save_worker] init called more than once — ignoring");
        return;
    }
    thread::Builder::new()
        .name("mindstream-drawing-save".into())
        .spawn(move || worker_loop(app, rx))
        .expect("spawn drawing save worker");
}

/// Mark a note's stroke document dirty. Called from the render
/// thread's `crate::drawing::notify_dirty` shim — non-blocking
/// channel send. If the worker isn't initialised yet (shouldn't
/// happen post-boot, but defensive), we silently drop the signal —
/// the note's bytes are still safe in the in-memory document, and
/// the next save trigger will pick them up.
pub fn notify_dirty(note_id: &str) {
    if let Some(tx) = WORKER_TX.get() {
        let _ = tx.send(SaveMsg::Dirty(note_id.to_string()));
    }
}

/// Push a new debounce setting to the worker. JS sends via
/// `drawing_set_save_debounce(ms)` whenever the user changes the
/// setting (or the editor initialises and confirms the default).
/// Cheap — just an `mpsc::send` of one u64.
pub fn set_debounce(ms: u64) {
    if let Some(tx) = WORKER_TX.get() {
        let _ = tx.send(SaveMsg::SetDebounce(ms));
    }
}

/// Force-flush every pending save right now, regardless of how much
/// of the debounce window has elapsed. Useful when the user
/// navigates away from a note while a save is pending — the
/// equivalent of the old JS-side "close-save" path. Non-blocking;
/// the worker handles the actual writes in its own time.
pub fn flush_all() {
    if let Some(tx) = WORKER_TX.get() {
        let _ = tx.send(SaveMsg::FlushAll);
    }
}

// ---------- internals ----------

fn worker_loop(app: AppHandle, rx: mpsc::Receiver<SaveMsg>) {
    let mut pending: HashMap<String, Instant> = HashMap::new();
    let mut debounce_ms: u64 = DEFAULT_DEBOUNCE_MS;
    log::info!("[drawing.save_worker] started (default debounce = {DEFAULT_DEBOUNCE_MS} ms)");

    loop {
        // Compute the next deadline = earliest (last_dirty +
        // debounce) across all pending notes. None = nothing
        // pending → block on a long idle sleep.
        let now = Instant::now();
        let next_deadline = pending
            .values()
            .map(|t| *t + Duration::from_millis(debounce_ms))
            .min();
        let wait = next_deadline
            .map(|d| d.saturating_duration_since(now))
            .unwrap_or(IDLE_SLEEP);

        match rx.recv_timeout(wait) {
            Ok(SaveMsg::Dirty(id)) => {
                let first_dirty_in_window = !pending.contains_key(&id);
                pending.insert(id.clone(), Instant::now());
                // Only emit "editing" on the *first* dirty event in
                // a debounce window — subsequent samples within the
                // same drag would otherwise spam the JS event bus.
                if first_dirty_in_window {
                    emit_status(&app, &id, SaveStatus::Editing);
                }
            }
            Ok(SaveMsg::SetDebounce(ms)) => {
                if ms != debounce_ms {
                    log::info!(
                        "[drawing.save_worker] debounce updated: {debounce_ms} ms -> {ms} ms"
                    );
                    debounce_ms = ms;
                }
            }
            Ok(SaveMsg::FlushAll) => {
                // Move every pending entry's deadline into the past
                // so the next loop iteration's deadline check fires
                // for all of them. Simpler than a duplicate save
                // path — preserves all the "saving" / "saved" event
                // emissions.
                let stale = Instant::now() - Duration::from_secs(3600);
                for instant in pending.values_mut() {
                    *instant = stale;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                // A deadline elapsed (or our idle sleep ended) —
                // drain everything that's overdue.
                let now = Instant::now();
                let due: Vec<String> = pending
                    .iter()
                    .filter(|(_, t)| {
                        now.saturating_duration_since(**t).as_millis() >= debounce_ms as u128
                    })
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in due {
                    pending.remove(&id);
                    save_one(&app, &id);
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                log::info!("[drawing.save_worker] channel disconnected — worker exiting");
                return;
            }
        }
    }
}

/// Run a single save: emit Saving → fetch bytes from the render
/// thread → write to SQLite → emit Saved / Error. Bounded by the
/// render thread's `get_state_for_note` 500 ms internal timeout +
/// however long the SQLite write takes (typically <10 ms for our
/// blob sizes).
fn save_one(app: &AppHandle, note_id: &str) {
    let t_total = Instant::now();
    emit_status(app, note_id, SaveStatus::Saving);

    let t_fetch = Instant::now();
    // The legacy native render thread owns an in-memory StrokesDoc
    // only on desktop now. Android's JS-canvas path calls
    // drawing_save_ink_state directly, so worker saves are a no-op
    // there.
    #[cfg(desktop)]
    let bytes = crate::drawing::render::get_state_for_note(note_id);
    #[cfg(not(desktop))]
    let bytes: Vec<u8> = Vec::new();
    let fetch_ms = t_fetch.elapsed();

    if bytes.is_empty() {
        // Either no in-memory doc for this id, or the doc encoded
        // to zero bytes (fresh / never-edited — shouldn't happen on
        // a dirty path). Treat as a successful no-op to avoid the
        // JS-side icon flickering on Error for a benign case.
        log::debug!("[drawing.save_worker] no bytes returned for {note_id} — treating as saved");
        emit_status(app, note_id, SaveStatus::Saved);
        return;
    }

    let byte_len = bytes.len();
    let t_write = Instant::now();
    let db = app.state::<Db>();
    let write_result = db.with_conn_mut(|c| notes::save_yrs_state(c, note_id, &bytes));
    let write_ms = t_write.elapsed();

    match write_result {
        Ok(true) => {
            log::info!(
                "[drawing.save_worker] saved {note_id}: bytes={byte_len} fetch={fetch_ms:?} write={write_ms:?} total={:?}",
                t_total.elapsed(),
            );
            emit_status(app, note_id, SaveStatus::Saved);
        }
        Ok(false) => {
            // Row missing — note was deleted while save was
            // pending. Not really an error; nothing to do.
            log::debug!("[drawing.save_worker] {note_id} not in db (deleted?) — skipping");
            emit_status(app, note_id, SaveStatus::Saved);
        }
        Err(e) => {
            log::warn!("[drawing.save_worker] save failed for {note_id}: {e:?}");
            emit_status(app, note_id, SaveStatus::Error);
        }
    }
}

fn emit_status(app: &AppHandle, note_id: &str, status: SaveStatus) {
    let event = SaveStatusEvent {
        note_id: note_id.to_string(),
        status,
    };
    if let Err(e) = app.emit(SAVE_STATUS_EVENT, &event) {
        log::warn!("[drawing.save_worker] emit {SAVE_STATUS_EVENT} failed: {e}");
    }
}
