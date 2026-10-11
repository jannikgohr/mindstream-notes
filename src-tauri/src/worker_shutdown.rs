//! A supervised worker exits only after every content window acknowledges saves.
use std::collections::BTreeSet;
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use uuid::Uuid;

use crate::error::{AppError, AppResult, CommandResult};

const CLOSE_EVENT: &str = "vault-worker-close";
const CLOSE_PROTOCOL: u32 = 2;
const CLOSE_TIMEOUT: Duration = Duration::from_secs(15);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
struct Book {
    ready: BTreeSet<String>,
    pending: Option<Batch>,
    committed: bool,
}

struct Batch {
    id: Uuid,
    windows: BTreeSet<String>,
    waiting: BTreeSet<String>,
    failed: bool,
}

impl Book {
    fn window_ready(&mut self, label: &str, protocol: u32) -> AppResult<()> {
        if protocol != CLOSE_PROTOCOL
            || !content_window(label)
            || self.pending.is_some()
            || self.committed
        {
            return Err(unavailable());
        }
        self.ready.insert(label.into());
        Ok(())
    }
    fn begin(&mut self, windows: BTreeSet<String>) -> AppResult<Option<Uuid>> {
        if self.pending.is_some() || self.committed {
            return Ok(None);
        }
        if !windows.contains("main") || !windows.is_subset(&self.ready) {
            return Err(unavailable());
        }
        let id = Uuid::new_v4();
        self.pending = Some(Batch {
            id,
            waiting: windows.clone(),
            windows,
            failed: false,
        });
        Ok(Some(id))
    }

    fn ack(&mut self, id: Uuid, window: &str, saved: bool) -> AppResult<()> {
        let batch = self.pending.as_mut().ok_or_else(unavailable)?;
        if batch.id != id || !batch.windows.contains(window) || self.committed {
            return Err(unavailable());
        }
        batch.waiting.remove(window);
        // A later successful retry cannot erase an earlier failure in this close.
        batch.failed |= !saved;
        Ok(())
    }

    fn finished(&self, id: Uuid) -> bool {
        self.pending
            .as_ref()
            .is_none_or(|batch| batch.id != id || batch.failed || batch.waiting.is_empty())
    }

    fn can_commit(&self, id: Uuid, windows: &BTreeSet<String>) -> bool {
        self.pending.as_ref().is_some_and(|batch| {
            batch.id == id && !batch.failed && batch.waiting.is_empty() && &batch.windows == windows
        })
    }

    fn commit(&mut self, id: Uuid, windows: &BTreeSet<String>) -> bool {
        let succeeds = self.can_commit(id, windows);
        if succeeds {
            self.committed = true;
        }
        succeeds
    }

    fn cancel(&mut self, id: Uuid) -> bool {
        if self.committed || !self.pending.as_ref().is_some_and(|batch| batch.id == id) {
            return false;
        }
        self.pending = None;
        true
    }
}

#[derive(Default)]
pub struct Shutdown {
    book: Mutex<Book>,
    changed: Condvar,
}

#[derive(Clone, Serialize)]
struct Notice {
    id: Uuid,
    phase: &'static str,
}

fn unavailable() -> AppError {
    AppError::InvalidArg("vault close could not be completed; the vault remains open".into())
}

fn content_window(label: &str) -> bool {
    label == "main" || label.starts_with("note_")
}

fn windows(app: &AppHandle) -> BTreeSet<String> {
    app.webview_windows()
        .into_keys()
        .filter(|label| content_window(label))
        .collect()
}

#[tauri::command]
pub fn vault_window_close_ready(
    app: AppHandle,
    window: WebviewWindow,
    protocol: u32,
) -> CommandResult<bool> {
    let Some(state) = app.try_state::<Shutdown>() else {
        return Ok(false);
    };
    let mut book = state.book.lock().map_err(|_| unavailable())?;
    book.window_ready(window.label(), protocol)?;
    Ok(true)
}

#[tauri::command]
pub fn vault_window_close_ack(
    app: AppHandle,
    window: WebviewWindow,
    id: Uuid,
    saved: bool,
) -> CommandResult<()> {
    let state = app.try_state::<Shutdown>().ok_or_else(unavailable)?;
    state
        .book
        .lock()
        .map_err(|_| unavailable())?
        .ack(id, window.label(), saved)?;
    state.changed.notify_all();
    Ok(())
}

/// Prevent secondary windows disappearing while another window is saving.
pub fn closing(app: &AppHandle) -> bool {
    app.try_state::<Shutdown>().is_some_and(|state| {
        state
            .book
            .lock()
            .map(|book| book.pending.is_some() && !book.committed)
            .unwrap_or(true)
    })
}

pub fn window_destroyed(app: &AppHandle, label: &str) {
    if let Some(state) = app.try_state::<Shutdown>() {
        if let Ok(mut book) = state.book.lock() {
            book.ready.remove(label);
            if let Some(batch) = &mut book.pending {
                batch.failed |= batch.windows.contains(label);
            }
            state.changed.notify_all();
        }
    }
}

fn cancel(app: &AppHandle, id: Uuid) {
    let Some(state) = app.try_state::<Shutdown>() else {
        return;
    };
    if state.book.lock().is_ok_and(|mut book| book.cancel(id)) {
        log::warn!("[vaults] controlled close cancelled; worker retained");
        let _ = app.emit(
            CLOSE_EVENT,
            Notice {
                id,
                phase: "cancel",
            },
        );
    }
}

fn notify(app: &AppHandle, participants: &BTreeSet<String>, id: Uuid, phase: &'static str) -> bool {
    participants.iter().all(|label| {
        app.get_webview_window(label).is_some_and(|_| {
            app.emit_to(label.clone(), CLOSE_EVENT, Notice { id, phase })
                .is_ok()
        })
    })
}

/// Called from the native close event; all waits happen off the event-loop thread.
pub fn request_close(app: &AppHandle) {
    log::debug!("[vaults] controlled close callback started");
    let Some(state) = app.try_state::<Shutdown>() else {
        return;
    };
    let participants = windows(app);
    let started = state
        .book
        .lock()
        .map_err(|_| unavailable())
        .and_then(|mut book| {
            if !crate::vault_supervisor::ready_for_close(app) {
                return Err(unavailable());
            }
            book.begin(participants.clone())
        });
    let id = match started {
        Ok(Some(id)) => id,
        Ok(None) => return,
        Err(_) => {
            log::warn!("[vaults] content windows are not ready for close");
            let _ = app.emit(
                CLOSE_EVENT,
                Notice {
                    id: Uuid::nil(),
                    phase: "cancel",
                },
            );
            return;
        }
    };
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("vault-close".into())
        .spawn(move || {
            log::debug!("[vaults] controlled close drain started");
            let Some(jobs) = handle.try_state::<crate::vault_jobs::Jobs>() else {
                cancel(&handle, id);
                return;
            };
            let Ok(paused) = jobs.pause() else {
                cancel(&handle, id);
                return;
            };
            if !notify(&handle, &participants, id, "waiting") {
                cancel(&handle, id);
                return;
            }
            if let Some(import) = handle.try_state::<crate::import::ImportState>() {
                import.cancel();
            }
            if let Err(error) = paused.wait(DRAIN_TIMEOUT) {
                log::warn!("[vaults] service drain failed: {error}");
                cancel(&handle, id);
                return;
            }
            log::debug!("[vaults] services drained; preparing content saves");
            // Services have emitted their final updates before editor saves.
            // Keep admission paused through the save/commit decision.
            if !notify(&handle, &participants, id, "prepare") {
                cancel(&handle, id);
                return;
            }
            let Some(state) = handle.try_state::<Shutdown>() else {
                return;
            };
            let Ok(book) = state.book.lock() else {
                cancel(&handle, id);
                return;
            };
            let waited = state
                .changed
                .wait_timeout_while(book, CLOSE_TIMEOUT, |book| !book.finished(id));
            // Release the book before scheduling work on the native event loop.
            if waited.is_err() {
                cancel(&handle, id);
                return;
            }
            drop(waited);
            log::debug!("[vaults] content acknowledgement wait finished");
            let Some(saves) = handle.try_state::<crate::vault_jobs::Saves>() else {
                cancel(&handle, id);
                return;
            };
            let Ok(saved) = saves.pause() else {
                cancel(&handle, id);
                return;
            };
            if let Err(error) = saved.wait(DRAIN_TIMEOUT) {
                log::warn!("[vaults] final save drain failed: {error}");
                cancel(&handle, id);
                return;
            }
            log::debug!("[vaults] final writes drained; scheduling close decision");
            let final_handle = handle.clone();
            if handle
                .run_on_main_thread(move || {
                    let Some(state) = final_handle.try_state::<Shutdown>() else {
                        return;
                    };
                    let current_windows = windows(&final_handle);
                    let committed = state.book.lock().is_ok_and(|mut book| {
                        if !book.can_commit(id, &current_windows)
                            || crate::vault_jobs::Pause::commit_all(vec![paused, saved]).is_err()
                        {
                            return false;
                        }
                        book.commit(id, &current_windows)
                    });
                    if committed {
                        log::info!("[vaults] every content window saved; closing worker");
                        final_handle.exit(0);
                    } else {
                        cancel(&final_handle, id);
                    }
                })
                .is_err()
            {
                cancel(&handle, id);
            }
        });
    if spawned.is_err() {
        cancel(app, id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frontend_without_the_wait_phase_cannot_authorize_close() {
        let mut book = Book::default();
        assert!(book.window_ready("main", 1).is_err());
        assert!(book.ready.is_empty());
        assert!(book.begin(BTreeSet::from(["main".into()])).is_err());
        assert!(book.window_ready("plugin_preview", CLOSE_PROTOCOL).is_err());
        book.window_ready("main", CLOSE_PROTOCOL).unwrap();
        book.begin(BTreeSet::from(["main".into()])).unwrap();
        assert!(book.window_ready("main", CLOSE_PROTOCOL).is_err());
    }

    fn ready() -> (Book, BTreeSet<String>) {
        let windows = BTreeSet::from(["main".into(), "note_seed_welcome".into()]);
        (
            Book {
                ready: windows.clone(),
                ..Book::default()
            },
            windows,
        )
    }

    #[test]
    fn main_ack_cannot_exit_before_popout_and_duplicate_close_reuses_batch() {
        let (mut book, windows) = ready();
        let id = book.begin(windows.clone()).unwrap().unwrap();
        assert_eq!(book.begin(windows.clone()).unwrap(), None);
        book.ack(id, "main", true).unwrap();
        assert!(!book.finished(id));
        assert!(!book.commit(id, &windows));
        book.ack(id, "note_seed_welcome", true).unwrap();
        assert!(book.commit(id, &windows));
        assert!(!book.cancel(id));
    }

    #[test]
    fn failure_stale_ack_and_changed_window_set_never_allow_exit() {
        let (mut book, windows) = ready();
        let id = book.begin(windows.clone()).unwrap().unwrap();
        assert!(book.ack(id, "plugin_export", true).is_err());
        assert!(book.ack(Uuid::new_v4(), "main", true).is_err());
        book.ack(id, "main", false).unwrap();
        book.ack(id, "main", true).unwrap();
        book.ack(id, "note_seed_welcome", true).unwrap();
        assert!(!book.commit(id, &windows));
        assert!(book.cancel(id));
        assert!(book.ack(id, "main", true).is_err());
        let retry = book.begin(windows.clone()).unwrap().unwrap();
        assert_ne!(retry, id);
        for window in &windows {
            book.ack(retry, window, true).unwrap();
        }
        assert!(!book.commit(retry, &BTreeSet::from(["main".into()])));
        let mut added = windows.clone();
        added.insert("note_new".into());
        assert!(!book.commit(retry, &added));
        assert!(book.commit(retry, &windows));
    }

    #[test]
    fn loading_or_missing_main_window_cannot_be_declared_saved() {
        let (mut book, mut windows) = ready();
        windows.insert("note_loading".into());
        assert!(book.begin(windows).is_err());
        assert!(book
            .begin(BTreeSet::from(["note_seed_welcome".into()]))
            .is_err());
        assert!(book.pending.is_none());
    }
}
