//! A worker accepts an action only once for a request ID and its lifetime.
//! Lost replies retry the same ID; they never authorize another vault/launch.
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::hotkeys::GlobalShortcutCommandId;

struct Receipt {
    command: GlobalShortcutCommandId,
    accelerator: Option<String>,
    result: Result<Value, String>,
    at: Instant,
}

#[derive(Default)]
pub(crate) struct Actions(Mutex<BTreeMap<Uuid, Receipt>>);

impl Actions {
    fn once(
        &self,
        id: Uuid,
        command: GlobalShortcutCommandId,
        accelerator: Option<String>,
        execute: impl FnOnce() -> AppResult<Value>,
    ) -> Result<Value, String> {
        let mut receipts = self.0.lock().map_err(|_| "shortcut receipts unavailable")?;
        receipts.retain(|_, receipt| receipt.at.elapsed() < Duration::from_secs(600));
        if let Some(receipt) = receipts.get(&id) {
            return if receipt.command == command && receipt.accelerator == accelerator {
                receipt.result.clone()
            } else {
                Err("shortcut request ID was reused for another command".into())
            };
        }
        if receipts.len() >= 1024 {
            return Err("shortcut replay capacity exceeded; action was not started".into());
        }
        // Serialize only this worker's action admission. No coordinator/IPC or
        // process-wide Book mutex is held through the operation.
        let result = execute().map_err(|error| error.to_string());
        receipts.insert(
            id,
            Receipt {
                command,
                accelerator,
                result: result.clone(),
                at: Instant::now(),
            },
        );
        result
    }
}

pub(crate) fn execute(
    app: &AppHandle,
    request_id: Uuid,
    command: GlobalShortcutCommandId,
    accelerator: Option<String>,
) -> Result<Value, String> {
    app.state::<Actions>()
        .once(request_id, command, accelerator.clone(), || {
            if crate::worker_shutdown::closing(app) {
                return Err(AppError::InvalidArg(
                    "shortcut destination is closing".into(),
                ));
            }
            let _job = app.state::<crate::vault_jobs::Jobs>().enter()?;
            let root = crate::paths::app_data_root(app)?;
            let vault = crate::paths::app_data_dir(app)?;
            let active = app.state::<crate::paths::ActiveProfile>();
            {
                let _lock = crate::storage_locks::RootLock::acquire(&root)?;
                let index = crate::profiles::load(&root)?.ok_or_else(|| {
                    AppError::InvalidArg("shortcut vault index is unavailable".into())
                })?;
                if !index.profiles.iter().any(|profile| profile.id == active.id) {
                    return Err(AppError::InvalidArg(
                        "shortcut destination was removed".into(),
                    ));
                }
                crate::coordinator_shortcuts::require_current_binding(
                    &root,
                    command,
                    accelerator.as_deref(),
                )?;
                if vault.join(".vault-deleting").try_exists()?
                    || !crate::ui_settings::shortcut_eligible(&root, &active.id, &vault)?
                {
                    return Err(AppError::InvalidArg(
                        "shortcut destination is no longer enabled".into(),
                    ));
                }
            }
            let note_id = if command == GlobalShortcutCommandId::ShowApp {
                None
            } else {
                let (title, kind) = match command {
                    GlobalShortcutCommandId::NewMarkdownNote => {
                        ("Untitled", crate::notes::NoteKind::Markdown)
                    }
                    GlobalShortcutCommandId::NewDrawing => {
                        ("Untitled drawing canvas", crate::notes::NoteKind::Freeform)
                    }
                    GlobalShortcutCommandId::NewInkNote => {
                        ("Untitled handwritten note", crate::notes::NoteKind::Ink)
                    }
                    GlobalShortcutCommandId::ShowApp => unreachable!(),
                };
                let note = app.state::<crate::db::Db>().with_conn(|conn| {
                    crate::notes::create(
                        conn,
                        crate::notes::CreateNote {
                            title: Some(title.into()),
                            body: None,
                            parent_collection_id: None,
                            note_kind: Some(kind),
                        },
                    )
                })?;
                Some(note.summary.id)
            };
            let focus = app.clone();
            // Never wait for the main thread while holding a root lock. The admitted
            // service job keeps the DB alive until creation and notification finish.
            if let Err(error) =
                app.run_on_main_thread(move || crate::tray::focus_main_window(&focus))
            {
                if note_id.is_none() {
                    return Err(error.into());
                }
                log::warn!("[shortcuts] note committed but focus failed: {error}");
            }
            if let Some(id) = &note_id {
                if let Err(error) = app.emit_to(
                    "main",
                    crate::app_events::AppEvent::TrayNoteCreated.as_str(),
                    json!({"note_id":id}),
                ) {
                    // The commit already happened. Cache success so delivery failure
                    // or a lost socket reply cannot cause a second DB write.
                    log::warn!("[shortcuts] note committed but notification failed: {error}");
                }
            }
            Ok(json!({"completed":true,"note_id":note_id}))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn retries_concurrent_replies_and_changed_inputs_never_execute_twice() {
        let actions = Actions::default();
        let calls = AtomicUsize::new(0);
        let id = Uuid::new_v4();
        std::thread::scope(|scope| {
            for _ in 0..12 {
                scope.spawn(|| {
                    assert_eq!(
                        actions
                            .once(id, GlobalShortcutCommandId::NewMarkdownNote, None, || {
                                calls.fetch_add(1, Ordering::Relaxed);
                                Ok(json!({"note_id":"one"}))
                            })
                            .unwrap(),
                        json!({"note_id":"one"})
                    )
                });
            }
        });
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert!(actions
            .once(
                id,
                GlobalShortcutCommandId::NewMarkdownNote,
                Some("Ctrl+K".into()),
                || panic!("changed binding input")
            )
            .is_err());
        assert!(actions
            .once(id, GlobalShortcutCommandId::NewDrawing, None, || panic!(
                "reused input"
            ))
            .is_err());
    }

    #[test]
    fn failed_admission_is_repeatable_and_capacity_fails_before_execution() {
        let actions = Actions::default();
        let id = Uuid::new_v4();
        assert!(actions
            .once(id, GlobalShortcutCommandId::ShowApp, None, || Err(
                AppError::InvalidArg("disabled".into())
            ))
            .is_err());
        assert!(actions
            .once(id, GlobalShortcutCommandId::ShowApp, None, || panic!(
                "failed request rerun"
            ))
            .is_err());
        for _ in 1..1024 {
            actions
                .once(
                    Uuid::new_v4(),
                    GlobalShortcutCommandId::ShowApp,
                    None,
                    || Ok(json!({})),
                )
                .unwrap();
        }
        assert!(actions
            .once(
                Uuid::new_v4(),
                GlobalShortcutCommandId::ShowApp,
                None,
                || panic!("capacity exceeded")
            )
            .is_err());
    }
}
