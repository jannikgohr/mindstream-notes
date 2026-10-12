//! Durable update intent. An atomic consumed tombstone prevents old sessions
//! being replayed on every normal startup. No previous-copy fallback is safe
//! here: resurrecting an older intent can reopen windows the user has closed.
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::storage_locks::RootLock;

const FILE: &str = "update-restart.json";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Window {
    pub label: String,
    pub note_id: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub visible: bool,
    pub minimized: bool,
    pub maximized: bool,
}

impl Window {
    pub(crate) fn validate(&self) -> AppResult<()> {
        match (&self.note_id, self.label.as_str()) {
            (None, "main") => {}
            (Some(id), label)
                if !id.is_empty()
                    && !id.chars().any(char::is_control)
                    && label
                        == if id.starts_with("note_") {
                            id.clone()
                        } else {
                            format!("note_{id}")
                        } => {}
            _ => return Err(invalid()),
        }
        if (self.label != "main"
            && !(self.label.starts_with("note_")
                && self.label.len() > 5
                && self.label.len() <= 256))
            || self.label.chars().any(char::is_control)
            || self.width == 0
            || self.height == 0
            || self.width > 65536
            || self.height > 65536
        {
            return Err(invalid());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Vault {
    pub id: String,
    pub directory: PathBuf,
    pub windows: Vec<Window>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Focus {
    pub vault_id: String,
    pub window: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Prepared,
    Installing,
    Failed,
    Consumed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Record {
    version: u32,
    pub operation_id: Uuid,
    root: PathBuf,
    source_version: String,
    target_version: String,
    phase: Phase,
    pub vaults: Vec<Vault>,
    pub focus: Option<Focus>,
    restored: BTreeSet<String>,
}

fn invalid() -> AppError {
    AppError::InvalidArg("update restart record is unavailable; recovery evidence retained".into())
}

impl Record {
    fn validate(&self) -> AppResult<()> {
        let mut ids = BTreeSet::new();
        if self.version != 1
            || self.operation_id.is_nil()
            || !self.root.is_absolute()
            || self.source_version.is_empty()
            || self.target_version.is_empty()
            || self.source_version.len() > 128
            || self.target_version.len() > 128
            || self.source_version == self.target_version
            || self.vaults.len() > 128
        {
            return Err(invalid());
        }
        for vault in &self.vaults {
            if !crate::profiles::valid_id(&vault.id)
                || !ids.insert(vault.id.as_str())
                || !vault.directory.is_absolute()
                || vault.windows.is_empty()
                || vault.windows.len() > 128
            {
                return Err(invalid());
            }
            let mut labels = BTreeSet::new();
            for window in &vault.windows {
                window.validate()?;
                if !labels.insert(window.label.as_str()) {
                    return Err(invalid());
                }
            }
            if !labels.contains("main") {
                return Err(invalid());
            }
        }
        if self.restored.iter().any(|id| !ids.contains(id.as_str())) {
            return Err(invalid());
        }
        if let Some(focus) = &self.focus {
            if !self.vaults.iter().any(|vault| {
                vault.id == focus.vault_id
                    && vault.windows.iter().any(|window| {
                        window.label == focus.window && window.visible && !window.minimized
                    })
            }) {
                return Err(invalid());
            }
        }
        Ok(())
    }

    pub(crate) fn pending(&self) -> impl Iterator<Item = &Vault> {
        self.vaults
            .iter()
            .filter(|vault| !self.restored.contains(&vault.id))
    }

    pub(crate) fn was_restored(&self, id: &str) -> bool {
        self.restored.contains(id)
    }

    fn may_resume(&self, running_version: &str) -> AppResult<bool> {
        if self.phase == Phase::Consumed {
            return Ok(false);
        }
        // On an interrupted/failed install the old binary can reopen the saved
        // session. A different unrelated binary must never consume this intent.
        if running_version == self.source_version
            || (running_version == self.target_version && self.phase == Phase::Installing)
        {
            return Ok(true);
        }
        Err(invalid())
    }
}

fn load_locked(root: &Path) -> AppResult<Option<Record>> {
    let raw = match fs::read(root.join(FILE)) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if raw.len() > 4 * 1024 * 1024 {
        return Err(invalid());
    }
    let record: Record = serde_json::from_slice(&raw).map_err(|_| invalid())?;
    record.validate()?;
    if record.root != fs::canonicalize(root)? {
        return Err(invalid());
    }
    Ok(Some(record))
}

fn write_locked(root: &Path, record: &Record) -> AppResult<()> {
    record.validate()?;
    let raw = serde_json::to_vec_pretty(record).map_err(|_| invalid())?;
    if raw.len() > 4 * 1024 * 1024 {
        return Err(invalid());
    }
    crate::atomic_file::write(&root.join(FILE), &raw)?;
    Ok(())
}

pub(crate) fn prepare(
    root: &Path,
    operation_id: Uuid,
    source_version: &str,
    target_version: &str,
    vaults: Vec<Vault>,
    focus: Option<Focus>,
) -> AppResult<Record> {
    let record = Record {
        version: 1,
        operation_id,
        root: fs::canonicalize(root)?,
        source_version: source_version.into(),
        target_version: target_version.into(),
        phase: Phase::Prepared,
        vaults,
        focus,
        restored: BTreeSet::new(),
    };
    record.validate()?;
    // Canonical paths pin the same physical indexed vaults. Never grant a
    // launch from this record alone or recreate missing vault directories.
    for vault in &record.vaults {
        if vault.directory != fs::canonicalize(crate::profiles::profile_dir(root, &vault.id))? {
            return Err(invalid());
        }
    }
    let _lock = RootLock::acquire(root)?;
    if let Some(previous) = load_locked(root)? {
        if previous == record {
            return Ok(previous);
        }
        if previous.phase != Phase::Consumed {
            return Err(invalid());
        }
    }
    write_locked(root, &record)?;
    Ok(record)
}

pub(crate) fn resume(root: &Path, running_version: &str) -> AppResult<Option<Record>> {
    let _lock = RootLock::acquire(root)?;
    let Some(record) = load_locked(root)? else {
        return Ok(None);
    };
    Ok(record.may_resume(running_version)?.then_some(record))
}

fn change(
    root: &Path,
    operation_id: Uuid,
    apply: impl FnOnce(&mut Record) -> AppResult<()>,
) -> AppResult<()> {
    let _lock = RootLock::acquire(root)?;
    let mut record = load_locked(root)?.ok_or_else(invalid)?;
    if record.operation_id != operation_id {
        return Err(invalid());
    }
    apply(&mut record)?;
    write_locked(root, &record)
}

pub(crate) fn installing(root: &Path, operation_id: Uuid) -> AppResult<()> {
    change(root, operation_id, |record| {
        if !matches!(record.phase, Phase::Prepared | Phase::Installing) {
            return Err(invalid());
        }
        record.phase = Phase::Installing;
        Ok(())
    })
}

pub(crate) fn failed(root: &Path, operation_id: Uuid) -> AppResult<()> {
    change(root, operation_id, |record| {
        if record.phase == Phase::Consumed {
            return Err(invalid());
        }
        record.phase = Phase::Failed;
        Ok(())
    })
}

pub(crate) fn restored(root: &Path, operation_id: Uuid, id: &str) -> AppResult<()> {
    change(root, operation_id, |record| {
        if record.phase == Phase::Consumed || !record.vaults.iter().any(|vault| vault.id == id) {
            return Err(invalid());
        }
        record.restored.insert(id.into());
        Ok(())
    })
}

/// Write the consumed state only after every saved vault and final activation
/// completed. Keep it on disk so previous copies cannot resurrect the session.
pub(crate) fn consume(root: &Path, operation_id: Uuid) -> AppResult<()> {
    change(root, operation_id, |record| {
        if record.pending().next().is_some() {
            return Err(invalid());
        }
        record.phase = Phase::Consumed;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_window_keeps_explicit_id_without_adding_or_removing_its_prefix() {
        let (root, vaults) = fixture();
        let mut window = vaults[0].windows[0].clone();
        window.label = "note_existing".into();
        window.note_id = Some("note_existing".into());
        window.validate().unwrap();
        window.label = "note_note_existing".into();
        assert!(window.validate().is_err());
        window.note_id = Some("existing".into());
        window.label = "note_existing".into();
        window.validate().unwrap();
        window.note_id = None;
        assert!(window.validate().is_err());
        fs::remove_dir_all(root).unwrap();
    }

    fn fixture() -> (PathBuf, Vec<Vault>) {
        let root = std::env::temp_dir().join(format!("ms-update-restart-{}", Uuid::new_v4()));
        let vaults = ["one", "two"]
            .into_iter()
            .map(|id| {
                let directory = crate::profiles::profile_dir(&root, id);
                fs::create_dir_all(&directory).unwrap();
                Vault {
                    id: id.into(),
                    directory: fs::canonicalize(directory).unwrap(),
                    windows: vec![Window {
                        label: "main".into(),
                        note_id: None,
                        x: -200,
                        y: 10,
                        width: 1000,
                        height: 800,
                        visible: id == "one",
                        minimized: false,
                        maximized: false,
                    }],
                }
            })
            .collect();
        (root, vaults)
    }

    #[test]
    fn partial_restart_resumes_and_consumed_intent_never_replays() {
        let (root, vaults) = fixture();
        let id = Uuid::new_v4();
        let record = prepare(&root, id, "1.0.0", "2.0.0", vaults.clone(), None).unwrap();
        assert_eq!(
            prepare(&root, id, "1.0.0", "2.0.0", vaults, None).unwrap(),
            record
        );
        assert!(resume(&root, "2.0.0").is_err());
        installing(&root, id).unwrap();
        assert!(consume(&root, id).is_err());
        restored(&root, id, "one").unwrap();
        restored(&root, id, "one").unwrap();
        let restart = resume(&root, "2.0.0").unwrap().unwrap();
        assert_eq!(
            restart.pending().map(|v| v.id.as_str()).collect::<Vec<_>>(),
            ["two"]
        );
        assert!(!restart.vaults[1].windows[0].visible);
        assert!(restored(&root, Uuid::new_v4(), "two").is_err());
        assert!(restored(&root, id, "missing").is_err());
        restored(&root, id, "two").unwrap();
        consume(&root, id).unwrap();
        consume(&root, id).unwrap();
        assert!(resume(&root, "2.0.0").unwrap().is_none());
        assert!(resume(&root, "1.0.0").unwrap().is_none());
        assert!(installing(&root, id).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_or_failed_install_restores_old_version_and_rejects_unrelated_build() {
        let (root, vaults) = fixture();
        let id = Uuid::new_v4();
        prepare(&root, id, "1", "2", vaults, None).unwrap();
        assert!(resume(&root, "1").unwrap().is_some());
        installing(&root, id).unwrap();
        assert!(resume(&root, "1").unwrap().is_some());
        assert!(resume(&root, "3").is_err());
        failed(&root, id).unwrap();
        assert!(resume(&root, "1").unwrap().is_some());
        assert!(resume(&root, "2").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_foreign_or_pending_record_cannot_be_overwritten() {
        let (root, vaults) = fixture();
        let id = Uuid::new_v4();
        prepare(&root, id, "1", "2", vaults.clone(), None).unwrap();
        assert!(prepare(&root, Uuid::new_v4(), "1", "3", vaults.clone(), None).is_err());
        let path = root.join(FILE);
        let mut record = load_locked(&root).unwrap().unwrap();
        record.root = root.join("foreign");
        fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(resume(&root, "1").is_err());
        fs::write(&path, b"corrupt evidence").unwrap();
        assert!(prepare(&root, id, "1", "2", vaults, None).is_err());
        assert_eq!(fs::read(path).unwrap(), b"corrupt evidence");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_duplicate_windows_missing_main_bad_geometry_and_hidden_focus() {
        let (root, mut vaults) = fixture();
        let duplicate = vaults[0].windows[0].clone();
        vaults[0].windows.push(duplicate);
        assert!(prepare(&root, Uuid::new_v4(), "1", "2", vaults.clone(), None).is_err());
        vaults[0].windows.pop();
        vaults[0].windows[0].label = "arbitrary".into();
        assert!(prepare(&root, Uuid::new_v4(), "1", "2", vaults.clone(), None).is_err());
        vaults[0].windows[0].label = "main".into();
        vaults[0].windows[0].width = 0;
        assert!(prepare(&root, Uuid::new_v4(), "1", "2", vaults.clone(), None).is_err());
        vaults[0].windows[0].width = 1000;
        assert!(prepare(
            &root,
            Uuid::new_v4(),
            "1",
            "2",
            vaults,
            Some(Focus {
                vault_id: "two".into(),
                window: "main".into()
            })
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
