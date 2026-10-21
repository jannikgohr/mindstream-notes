//! Device-local first-run progress. The coordinator initializes this before
//! creating a vault; a vault worker claims the flow only from its main window.
use std::{fs, path::Path};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::environment::Kind;
use crate::error::{AppError, AppResult, CommandResult};
use crate::storage_locks::RootLock;

const FILE: &str = "onboarding.json";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    Account,
    Appearance,
    Editing,
    Start,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    InProgress,
    Completed,
    Skipped,
    Existing,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Progress {
    version: u32,
    id: Uuid,
    status: Status,
    step: Step,
    vault_id: Option<String>,
    fresh_install: bool,
    #[serde(default)]
    initial_note_id: Option<String>,
}

impl Progress {
    fn new(status: Status, fresh_install: bool) -> Self {
        Self {
            version: 1,
            id: Uuid::new_v4(),
            status,
            step: Step::Account,
            vault_id: None,
            fresh_install,
            initial_note_id: None,
        }
    }

    fn owned_by(&self, id: Uuid, vault: &str) -> AppResult<()> {
        if self.id != id
            || self.status != Status::InProgress
            || self.vault_id.as_deref() != Some(vault)
        {
            return Err(AppError::InvalidArg(
                "onboarding session changed; reload setup".into(),
            ));
        }
        Ok(())
    }
}

fn validate(raw: &[u8]) -> AppResult<()> {
    let progress: Progress = serde_json::from_slice(raw)
        .map_err(|err| AppError::InvalidArg(format!("invalid onboarding progress: {err}")))?;
    if progress.version != 1 || progress.id.is_nil() {
        return Err(AppError::InvalidArg(
            "unsupported onboarding progress".into(),
        ));
    }
    Ok(())
}

fn read(root: &Path) -> AppResult<Progress> {
    let path = root.join(FILE);
    crate::root_documents::recover(&path, validate, validate)?;
    let raw = fs::read(path)?;
    validate(&raw)?;
    serde_json::from_slice(&raw).map_err(|err| AppError::InvalidArg(err.to_string()))
}

fn write(root: &Path, progress: &Progress) -> AppResult<()> {
    let raw =
        serde_json::to_vec_pretty(progress).map_err(|err| AppError::InvalidArg(err.to_string()))?;
    crate::root_documents::write(&root.join(FILE), &raw, validate)
}

pub fn force_requested() -> bool {
    std::env::args().any(|arg| arg == "--onboarding")
}

/// Must run before profile migration, index creation, or database seeding.
pub fn initialize(root: &Path, kind: Kind, force: bool) -> AppResult<()> {
    let _lock = RootLock::acquire(root)?;
    crate::root_documents::recover(&root.join(FILE), validate, validate)?;
    let exists = root.join(FILE).try_exists()?;
    if exists && !force {
        // An explicit dev/test preview applies to that launch. A later ordinary
        // development launch must remain free of setup. Workers do not call
        // initialize, so they retain their coordinator's explicit request.
        if kind != Kind::Release {
            let mut previous = read(root)?;
            if previous.status == Status::InProgress {
                previous.status = Status::Skipped;
                write(root, &previous)?;
            }
        }
        return Ok(());
    }
    let existing = root.join("profiles.json").try_exists()?
        || root.join("mindstream.db").try_exists()?
        || root.join("desktop-settings.json").try_exists()?;
    let status = if force || (!existing && kind == Kind::Release) {
        Status::InProgress
    } else if existing {
        Status::Existing
    } else {
        Status::Skipped
    };
    write(root, &Progress::new(status, !existing))
}

pub fn should_seed_demo(root: &Path, kind: Kind) -> AppResult<bool> {
    let _lock = RootLock::acquire(root)?;
    Ok(kind != Kind::Release && read(root)?.status != Status::InProgress)
}

fn active_vault<R: tauri::Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
) -> AppResult<String> {
    if window.label() != "main" {
        return Err(AppError::InvalidArg(
            "setup is available in the main window".into(),
        ));
    }
    app.try_state::<crate::paths::ActiveProfile>()
        .map(|profile| profile.id.clone())
        .ok_or_else(|| AppError::InvalidArg("no active vault".into()))
}

#[tauri::command]
pub fn get_onboarding<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: tauri::WebviewWindow<R>,
) -> CommandResult<Progress> {
    let vault = active_vault(&app, &window)?;
    let root = crate::paths::app_data_root(&app)?;
    let _lock = RootLock::acquire(&root)?;
    let mut progress = read(&root)?;
    if progress.status == Status::InProgress && progress.vault_id.is_none() {
        progress.vault_id = Some(vault);
        write(&root, &progress)?;
    }
    Ok(progress)
}

#[tauri::command]
pub fn restart_onboarding<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: tauri::WebviewWindow<R>,
) -> CommandResult<Progress> {
    let vault = active_vault(&app, &window)?;
    let root = crate::paths::app_data_root(&app)?;
    let _lock = RootLock::acquire(&root)?;
    let mut previous = read(&root)?;
    if previous.status == Status::InProgress {
        if previous.vault_id.as_deref().is_some_and(|id| id != vault) {
            return Err(AppError::InvalidArg("setup is open in another vault".into()).into());
        }
        if previous.vault_id.is_none() {
            previous.vault_id = Some(vault);
            write(&root, &previous)?;
        }
        return Ok(previous);
    }
    let mut progress = Progress::new(Status::InProgress, false);
    progress.vault_id = Some(vault);
    write(&root, &progress)?;
    Ok(progress)
}

#[tauri::command]
pub fn save_onboarding_step<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    id: Uuid,
    step: Step,
) -> CommandResult<Progress> {
    let vault = active_vault(&app, &window)?;
    let root = crate::paths::app_data_root(&app)?;
    let _lock = RootLock::acquire(&root)?;
    let mut progress = read(&root)?;
    progress.owned_by(id, &vault)?;
    progress.step = step;
    write(&root, &progress)?;
    Ok(progress)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitialNote {
    title: String,
    body: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    progress: Progress,
    note_id: Option<String>,
}

#[tauri::command]
pub fn finish_onboarding<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    db: tauri::State<'_, crate::db::Db>,
    id: Uuid,
    skipped: bool,
    initial_note: Option<InitialNote>,
    demo_notes: Vec<crate::demo_notes::DemoNote>,
) -> CommandResult<Finished> {
    let vault = active_vault(&app, &window)?;
    let root = crate::paths::app_data_root(&app)?;
    let finished = finish(&root, &vault, &db, id, skipped, initial_note, demo_notes)?;
    app.emit(crate::app_events::AppEvent::OnboardingChanged.as_str(), ())?;
    Ok(finished)
}

fn finish(
    root: &Path,
    vault: &str,
    db: &crate::db::Db,
    id: Uuid,
    skipped: bool,
    initial_note: Option<InitialNote>,
    demo_notes: Vec<crate::demo_notes::DemoNote>,
) -> AppResult<Finished> {
    let _lock = RootLock::acquire(root)?;
    let mut progress = read(root)?;
    if progress.id == id
        && progress.vault_id.as_deref() == Some(vault)
        && matches!(progress.status, Status::Completed | Status::Skipped)
    {
        return Ok(Finished {
            note_id: progress.initial_note_id.clone(),
            progress,
        });
    }
    progress.owned_by(id, vault)?;
    if initial_note.is_some() && !demo_notes.is_empty() {
        return Err(AppError::InvalidArg(
            "setup starts with a note or with demo notes, not both".into(),
        ));
    }
    let note_id = if let Some(note) = initial_note {
        if note.title.is_empty() || note.title.len() > 512 || note.body.len() > 32768 {
            return Err(AppError::InvalidArg("invalid initial note".into()));
        }
        let note_id = format!("onboarding_{id}");
        db.with_conn(|conn| {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM notes WHERE id = ?1)",
                [&note_id],
                |row| row.get(0),
            )?;
            if !exists {
                crate::db::migrations::insert_note(
                    conn,
                    &note_id,
                    &note.title,
                    &note.body,
                    None,
                    0,
                    &chrono::Utc::now().to_rfc3339(),
                )?;
            }
            Ok(())
        })?;
        Some(note_id)
    } else if demo_notes.is_empty() {
        None
    } else {
        let now = chrono::Utc::now().to_rfc3339();
        let ids = db.with_conn_mut(|conn| {
            let tx = conn.transaction()?;
            let ids = crate::demo_notes::insert(&tx, &demo_notes, &now)?;
            tx.commit()?;
            Ok(ids)
        })?;
        ids.into_iter().next()
    };
    progress.status = if skipped {
        Status::Skipped
    } else {
        Status::Completed
    };
    progress.initial_note_id = note_id.clone();
    write(root, &progress)?;
    Ok(Finished { progress, note_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("ms-onboarding-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn fresh_release_runs_once_and_dev_and_test_opt_out() {
        for kind in [Kind::Release, Kind::Dev, Kind::Test] {
            let root = root();
            initialize(&root, kind, false).unwrap();
            let progress = read(&root).unwrap();
            assert_eq!(progress.status == Status::InProgress, kind == Kind::Release);
            assert_eq!(
                should_seed_demo(&root, kind).unwrap(),
                kind != Kind::Release
            );
            initialize(&root, kind, false).unwrap();
            assert_eq!(read(&root).unwrap().id, progress.id);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn upgrades_skip_and_force_starts_a_new_session_without_modifying_vaults() {
        let root = root();
        fs::write(root.join("profiles.json"), "existing vaults").unwrap();
        initialize(&root, Kind::Release, false).unwrap();
        assert_eq!(read(&root).unwrap().status, Status::Existing);
        initialize(&root, Kind::Dev, true).unwrap();
        let progress = read(&root).unwrap();
        assert_eq!(progress.status, Status::InProgress);
        assert!(!progress.fresh_install);
        initialize(&root, Kind::Dev, false).unwrap();
        assert_eq!(read(&root).unwrap().status, Status::Skipped);
        assert_eq!(
            fs::read_to_string(root.join("profiles.json")).unwrap(),
            "existing vaults"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn progress_resumes_and_rejects_stale_or_other_vault_writes() {
        let root = root();
        initialize(&root, Kind::Release, false).unwrap();
        let mut progress = read(&root).unwrap();
        progress.vault_id = Some("default".into());
        progress.step = Step::Appearance;
        write(&root, &progress).unwrap();
        initialize(&root, Kind::Release, false).unwrap();
        let resumed = read(&root).unwrap();
        assert_eq!(resumed.step, Step::Appearance);
        assert!(resumed.owned_by(progress.id, "default").is_ok());
        assert!(resumed.owned_by(Uuid::new_v4(), "default").is_err());
        assert!(resumed.owned_by(progress.id, "other").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn completion_is_retryable_and_initial_content_is_created_once() {
        let root = root();
        initialize(&root, Kind::Release, false).unwrap();
        let mut progress = read(&root).unwrap();
        progress.vault_id = Some("default".into());
        write(&root, &progress).unwrap();
        let db = crate::db::open_memory_for_tests();
        let first = finish(
            &root,
            "default",
            &db,
            progress.id,
            false,
            Some(InitialNote {
                title: "Welcome".into(),
                body: "# My notes".into(),
            }),
            Vec::new(),
        )
        .unwrap();
        let retry = finish(&root, "default", &db, progress.id, false, None, Vec::new()).unwrap();
        assert_eq!(first.note_id, retry.note_id);
        assert_eq!(retry.progress.status, Status::Completed);
        assert!(finish(&root, "other", &db, progress.id, false, None, Vec::new()).is_err());
        db.with_conn(|conn| {
            let count: u32 = conn.query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))?;
            assert_eq!(count, 1);
            Ok(())
        })
        .unwrap();
        initialize(&root, Kind::Release, false).unwrap();
        assert_eq!(read(&root).unwrap().status, Status::Completed);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn demo_notes_are_added_and_the_first_one_opens() {
        let root = root();
        initialize(&root, Kind::Release, false).unwrap();
        let mut progress = read(&root).unwrap();
        progress.vault_id = Some("default".into());
        write(&root, &progress).unwrap();
        let db = crate::db::open_memory_for_tests();
        let demo = |slug: &str| -> crate::demo_notes::DemoNote {
            serde_json::from_value(serde_json::json!({
                "slug": slug,
                "lang": "en",
                "title": "Welcome",
                "body": "Hello\n",
                "yrsState": crate::sync::yrs_doc::editor_state_for_tests("Hello"),
            }))
            .unwrap()
        };
        let both = finish(
            &root,
            "default",
            &db,
            progress.id,
            false,
            Some(InitialNote {
                title: "Mine".into(),
                body: String::new(),
            }),
            vec![demo("welcome")],
        );
        assert!(both.is_err());
        let finished = finish(
            &root,
            "default",
            &db,
            progress.id,
            false,
            None,
            vec![demo("welcome"), demo("basics")],
        )
        .unwrap();
        let note_id = finished.note_id.unwrap();
        assert!(note_id.starts_with("demo_welcome_en_"));
        assert_eq!(read(&root).unwrap().initial_note_id, Some(note_id));
        db.with_conn(|conn| {
            let count: u32 = conn.query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))?;
            assert_eq!(count, 2);
            Ok(())
        })
        .unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skipping_and_reopening_do_not_seed_or_delete_notes() {
        let root = root();
        initialize(&root, Kind::Release, false).unwrap();
        let mut progress = read(&root).unwrap();
        progress.vault_id = Some("default".into());
        write(&root, &progress).unwrap();
        let db = crate::db::open_memory_for_tests();
        finish(&root, "default", &db, progress.id, true, None, Vec::new()).unwrap();
        initialize(&root, Kind::Release, false).unwrap();
        assert_eq!(read(&root).unwrap().status, Status::Skipped);
        assert!(!should_seed_demo(&root, Kind::Release).unwrap());
        fs::remove_dir_all(root).unwrap();
    }
}
