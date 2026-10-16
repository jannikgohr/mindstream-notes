//! A worker accepts an action only once for a request ID and its lifetime.
//! Lost replies retry the same ID; they never authorize another vault/launch.
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::hotkeys::GlobalShortcutCommandId;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TrayCommand {
    MarkdownNote,
    Drawing,
    InkNote,
    Diagram,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Input {
    Shortcut(GlobalShortcutCommandId, Option<String>),
    Tray(TrayCommand),
}

struct Receipt {
    input: Input,
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
        self.once_input(id, Input::Shortcut(command, accelerator), execute)
    }

    fn once_input(
        &self,
        id: Uuid,
        input: Input,
        execute: impl FnOnce() -> AppResult<Value>,
    ) -> Result<Value, String> {
        let mut receipts = self.0.lock().map_err(|_| "capture receipts unavailable")?;
        receipts.retain(|_, receipt| receipt.at.elapsed() < Duration::from_secs(600));
        if let Some(receipt) = receipts.get(&id) {
            return if receipt.input == input {
                receipt.result.clone()
            } else {
                Err("capture request ID was reused for another command".into())
            };
        }
        if receipts.len() >= 1024 {
            return Err("capture replay capacity exceeded; action was not started".into());
        }
        // Serialize only this worker's action admission. No coordinator/IPC or
        // process-wide Book mutex is held through the operation.
        let result = execute().map_err(|error| error.to_string());
        receipts.insert(
            id,
            Receipt {
                input,
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
            perform(app, Input::Shortcut(command, accelerator))
        })
}

pub(crate) fn execute_tray(
    app: &AppHandle,
    request_id: Uuid,
    command: TrayCommand,
) -> Result<Value, String> {
    app.state::<Actions>()
        .once_input(request_id, Input::Tray(command), || {
            perform(app, Input::Tray(command))
        })
}

fn perform(app: &AppHandle, input: Input) -> AppResult<Value> {
    if crate::worker_shutdown::closing(app) {
        return Err(AppError::InvalidArg(
            "capture destination is closing".into(),
        ));
    }
    let _job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    let root = crate::paths::app_data_root(app)?;
    let vault = crate::paths::app_data_dir(app)?;
    let active = app.state::<crate::paths::ActiveProfile>();
    admit(&root, &vault, &active.id, &input)?;
    let note_id = match template(&input) {
        Some(template) => Some(
            app.state::<crate::db::Db>()
                .with_conn(|conn| create_note(conn, template))?,
        ),
        None => None,
    };
    let focus = app.clone();
    // The admitted service job keeps the DB alive until creation/notification.
    // No root lock crosses main-thread scheduling or a database write.
    if let Err(error) = app.run_on_main_thread(move || crate::tray::focus_main_window(&focus)) {
        if note_id.is_none() {
            return Err(error.into());
        }
        log::warn!("[capture] note committed but focus failed: {error}");
    }
    if let Some(id) = &note_id {
        if let Err(error) = app.emit_to(
            "main",
            crate::app_events::AppEvent::TrayNoteCreated.as_str(),
            json!({"note_id":id}),
        ) {
            // Cache success after commit, even if notification delivery fails.
            log::warn!("[capture] note committed but notification failed: {error}");
        }
    }
    Ok(json!({"completed":true,"note_id":note_id}))
}

/// The destination vault must still be indexed and not being deleted, and a
/// shortcut must still be bound and enabled there. The root lock is released
/// before any note is written.
fn admit(
    root: &std::path::Path,
    vault: &std::path::Path,
    vault_id: &str,
    input: &Input,
) -> AppResult<()> {
    let _lock = crate::storage_locks::RootLock::acquire(root)?;
    let index = crate::profiles::load(root)?
        .ok_or_else(|| AppError::InvalidArg("capture vault index is unavailable".into()))?;
    if !index.profiles.iter().any(|profile| profile.id == vault_id)
        || vault.join(".vault-deleting").try_exists()?
    {
        return Err(AppError::InvalidArg(
            "capture destination was removed".into(),
        ));
    }
    if let Input::Shortcut(command, accelerator) = input {
        crate::coordinator_shortcuts::require_current_binding(
            root,
            *command,
            accelerator.as_deref(),
        )?;
        if !crate::ui_settings::shortcut_eligible(root, vault_id, vault)? {
            return Err(AppError::InvalidArg(
                "shortcut destination is no longer enabled".into(),
            ));
        }
    }
    Ok(())
}

type Template = (&'static str, Option<&'static str>, crate::notes::NoteKind);

/// The note a capture creates. Showing the app creates none.
fn template(input: &Input) -> Option<Template> {
    match input {
        Input::Shortcut(GlobalShortcutCommandId::ShowApp, _) => None,
        Input::Shortcut(GlobalShortcutCommandId::NewMarkdownNote, _)
        | Input::Tray(TrayCommand::MarkdownNote) => {
            Some(("Untitled", None, crate::notes::NoteKind::Markdown))
        }
        Input::Shortcut(GlobalShortcutCommandId::NewDrawing, _)
        | Input::Tray(TrayCommand::Drawing) => Some((
            "Untitled drawing canvas",
            None,
            crate::notes::NoteKind::Freeform,
        )),
        Input::Shortcut(GlobalShortcutCommandId::NewInkNote, _)
        | Input::Tray(TrayCommand::InkNote) => Some((
            "Untitled handwritten note",
            None,
            crate::notes::NoteKind::Ink,
        )),
        Input::Tray(TrayCommand::Diagram) => Some((
            "Untitled diagram",
            Some("```mermaid\nflowchart TD\n  A[Start] --> B[Next]\n```\n"),
            crate::notes::NoteKind::Markdown,
        )),
    }
}

fn create_note(conn: &rusqlite::Connection, (title, body, kind): Template) -> AppResult<String> {
    let note = crate::notes::create(
        conn,
        crate::notes::CreateNote {
            title: Some(title.into()),
            body: body.map(str::to_string),
            parent_collection_id: None,
            note_kind: Some(kind),
        },
    )?;
    Ok(note.summary.id)
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
    fn tray_and_shortcut_requests_cannot_reuse_each_others_receipts() {
        let actions = Actions::default();
        let id = Uuid::new_v4();
        actions
            .once_input(id, Input::Tray(TrayCommand::MarkdownNote), || {
                Ok(json!({"note_id":"tray"}))
            })
            .unwrap();
        assert_eq!(
            actions
                .once_input(id, Input::Tray(TrayCommand::MarkdownNote), || panic!(
                    "tray retry"
                ))
                .unwrap(),
            json!({"note_id":"tray"})
        );
        assert!(actions
            .once(
                id,
                GlobalShortcutCommandId::NewMarkdownNote,
                None,
                || panic!("cross-origin retry")
            )
            .is_err());
        assert!(actions
            .once_input(id, Input::Tray(TrayCommand::Diagram), || panic!(
                "changed tray kind"
            ))
            .is_err());
    }

    #[test]
    fn each_capture_creates_its_note_kind_and_showing_the_app_creates_none() {
        use crate::notes::NoteKind;
        assert!(template(&Input::Shortcut(GlobalShortcutCommandId::ShowApp, None)).is_none());
        let db = crate::db::open_memory_for_tests();
        for (input, title, kind) in [
            (
                Input::Shortcut(GlobalShortcutCommandId::NewMarkdownNote, None),
                "Untitled",
                NoteKind::Markdown,
            ),
            (
                Input::Tray(TrayCommand::MarkdownNote),
                "Untitled",
                NoteKind::Markdown,
            ),
            (
                Input::Shortcut(GlobalShortcutCommandId::NewDrawing, Some("Ctrl+D".into())),
                "Untitled drawing canvas",
                NoteKind::Freeform,
            ),
            (
                Input::Tray(TrayCommand::Drawing),
                "Untitled drawing canvas",
                NoteKind::Freeform,
            ),
            (
                Input::Shortcut(GlobalShortcutCommandId::NewInkNote, None),
                "Untitled handwritten note",
                NoteKind::Ink,
            ),
            (
                Input::Tray(TrayCommand::InkNote),
                "Untitled handwritten note",
                NoteKind::Ink,
            ),
            (
                Input::Tray(TrayCommand::Diagram),
                "Untitled diagram",
                NoteKind::Markdown,
            ),
        ] {
            let id = db
                .with_conn(|conn| create_note(conn, template(&input).unwrap()))
                .unwrap();
            let note = db.with_conn(|conn| crate::notes::load(conn, &id)).unwrap();
            assert_eq!(note.summary.title, title);
            assert_eq!(note.summary.note_kind, kind);
            assert_eq!(
                note.body.starts_with("```mermaid"),
                input == Input::Tray(TrayCommand::Diagram)
            );
        }
    }

    #[test]
    fn captures_need_an_indexed_live_vault_and_shortcuts_a_current_enabled_binding() {
        let root = std::env::temp_dir().join(format!("ms-capture-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let tray = Input::Tray(TrayCommand::MarkdownNote);
        let vault = crate::profiles::profile_dir(&root, "default");
        assert!(admit(&root, &vault, "default", &tray).is_err());
        crate::profiles::load_or_init(&root).unwrap();
        admit(&root, &vault, "default", &tray).unwrap();
        assert!(admit(&root, &vault, "removed", &tray).is_err());

        let shortcut = Input::Shortcut(GlobalShortcutCommandId::NewMarkdownNote, None);
        assert!(
            admit(&root, &vault, "default", &shortcut).is_err(),
            "shortcuts are disabled until the vault enables them"
        );
        std::fs::write(
            vault.join("content-settings.json"),
            r#"{"version":1,"revision":1,"values":{"hotkeys.globalShortcuts":true}}"#,
        )
        .unwrap();
        admit(&root, &vault, "default", &shortcut).unwrap();
        let rebound = Input::Shortcut(
            GlobalShortcutCommandId::NewMarkdownNote,
            Some("CommandOrControl+Alt+KeyM".into()),
        );
        assert!(admit(&root, &vault, "default", &rebound).is_err());

        std::fs::write(vault.join(".vault-deleting"), b"pending").unwrap();
        assert!(admit(&root, &vault, "default", &tray).is_err());
        std::fs::remove_dir_all(root).unwrap();
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
