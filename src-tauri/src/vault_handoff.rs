//! A handoff intent binds exact physical vaults and launch identities. Older
//! intents must never be recovered from a previous copy and replay a close.
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::storage_locks::RootLock;
use crate::update_recovery::Window;

const FILE: &str = "vault-handoff.json";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Worker {
    pub id: String,
    pub directory: PathBuf,
    pub launch_id: Uuid,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Phase {
    Preparing,
    Closing,
    Closed,
    Completed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Record {
    version: u32,
    root: PathBuf,
    pub operation_id: Uuid,
    pub source: Worker,
    pub target: Worker,
    pub geometry: Window,
    pub source_close: Uuid,
    pub target_close: Uuid,
    pub restore: Uuid,
    pub activation_restore: Uuid,
    pub phase: Phase,
}

fn invalid() -> AppError {
    AppError::InvalidArg("vault handoff recovery is unavailable; its evidence is retained".into())
}

impl Record {
    pub fn active(&self) -> bool {
        !matches!(self.phase, Phase::Completed | Phase::Cancelled)
    }

    fn validate(&self) -> AppResult<()> {
        self.geometry.validate()?;
        if self.version != 1
            || !self.root.is_absolute()
            || self.geometry.label != "main"
            || self.geometry.note_id.is_some()
            || self.source.id == self.target.id
            || self.source.directory == self.target.directory
            || [
                self.operation_id,
                self.source_close,
                self.target_close,
                self.restore,
                self.activation_restore,
                self.source.launch_id,
                self.target.launch_id,
            ]
            .iter()
            .any(Uuid::is_nil)
        {
            return Err(invalid());
        }
        for worker in [&self.source, &self.target] {
            if !crate::profiles::valid_id(&worker.id) || !worker.directory.is_absolute() {
                return Err(invalid());
            }
        }
        Ok(())
    }

    pub fn verify_paths(&self, root: &Path) -> AppResult<()> {
        if self.root != fs::canonicalize(root)? {
            return Err(invalid());
        }
        for worker in [&self.source, &self.target] {
            if worker.directory != fs::canonicalize(crate::profiles::profile_dir(root, &worker.id))?
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
}

fn read_locked(root: &Path) -> AppResult<Option<Record>> {
    let raw = match fs::read(root.join(FILE)) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if raw.len() > 65536 {
        return Err(invalid());
    }
    let record: Record = serde_json::from_slice(&raw).map_err(|_| invalid())?;
    record.validate()?;
    // A terminal record is only a tombstone. It stays readable after the root
    // moves; an active intent must still describe this physical root.
    if record.active() && record.root != fs::canonicalize(root)? {
        return Err(invalid());
    }
    Ok(Some(record))
}

/// An intent that is unreadable or names other physical vaults can never be
/// resumed here. Set it aside so it cannot fail every later startup.
pub(crate) fn quarantine_unresumable(root: &Path) -> AppResult<Option<PathBuf>> {
    let _lock = RootLock::acquire(root)?;
    let resumable = match read_locked(root) {
        Ok(None) => return Ok(None),
        Ok(Some(record)) => !record.active() || record.verify_paths(root).is_ok(),
        Err(AppError::InvalidArg(_)) => false,
        Err(error) => return Err(error),
    };
    if resumable {
        return Ok(None);
    }
    crate::root_documents::set_aside(&root.join(FILE)).map(Some)
}

fn write_locked(root: &Path, record: &Record) -> AppResult<()> {
    record.validate()?;
    crate::atomic_file::write(
        &root.join(FILE),
        &serde_json::to_vec_pretty(record).map_err(|_| invalid())?,
    )?;
    Ok(())
}

pub(crate) fn load(root: &Path) -> AppResult<Option<Record>> {
    let _lock = RootLock::acquire(root)?;
    read_locked(root)
}

pub(crate) fn prepare(
    root: &Path,
    operation_id: Uuid,
    source: Worker,
    target: Worker,
    geometry: Window,
) -> AppResult<Record> {
    let record = Record {
        version: 1,
        root: fs::canonicalize(root)?,
        operation_id,
        source,
        target,
        geometry,
        source_close: Uuid::new_v4(),
        target_close: Uuid::new_v4(),
        restore: Uuid::new_v4(),
        activation_restore: Uuid::new_v4(),
        phase: Phase::Preparing,
    };
    record.validate()?;
    record.verify_paths(root)?;
    let _lock = RootLock::acquire(root)?;
    if let Some(previous) = read_locked(root)? {
        if previous.active() {
            return Err(invalid());
        }
        // Preserve the previous terminal record before accepting another intent.
        crate::atomic_file::write(
            &root.join(format!(".vault-handoff-{}.json", previous.operation_id)),
            &serde_json::to_vec_pretty(&previous).map_err(|_| invalid())?,
        )?;
    }
    write_locked(root, &record)?;
    Ok(record)
}

pub(crate) fn advance(root: &Path, id: Uuid, phase: Phase) -> AppResult<Record> {
    let _lock = RootLock::acquire(root)?;
    let mut record = read_locked(root)?.ok_or_else(invalid)?;
    if record.operation_id != id {
        return Err(invalid());
    }
    if record.phase != phase
        && !matches!(
            (record.phase, phase),
            (Phase::Preparing, Phase::Closing | Phase::Cancelled)
                | (Phase::Closing, Phase::Closed | Phase::Cancelled)
                | (Phase::Closed, Phase::Completed)
        )
    {
        return Err(invalid());
    }
    record.phase = phase;
    write_locked(root, &record)?;
    Ok(record)
}

/// Give up on an intent that keeps failing. Its evidence is retained under
/// another name; nothing replays its close or pins its target any longer.
pub(crate) fn abandon(root: &Path) -> AppResult<Option<PathBuf>> {
    let _lock = RootLock::acquire(root)?;
    if !root.join(FILE).try_exists()? {
        return Ok(None);
    }
    crate::root_documents::set_aside(&root.join(FILE)).map(Some)
}

/// Caller has proved the old target's physical lease is released. Journal the
/// replacement before spawning it; never reuse a prior process launch identity.
pub(crate) fn replace_target(root: &Path, id: Uuid) -> AppResult<Record> {
    let _lock = RootLock::acquire(root)?;
    let mut record = read_locked(root)?.ok_or_else(invalid)?;
    if record.operation_id != id || !record.active() {
        return Err(invalid());
    }
    record.target.launch_id = Uuid::new_v4();
    record.restore = Uuid::new_v4();
    record.activation_restore = Uuid::new_v4();
    record.target_close = Uuid::new_v4();
    write_locked(root, &record)?;
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, Worker, Worker, Window) {
        let root = std::env::temp_dir().join(format!("ms-handoff-{}", Uuid::new_v4()));
        for id in ["source", "target"] {
            fs::create_dir_all(crate::profiles::profile_dir(&root, id)).unwrap();
        }
        let worker = |id: &str| Worker {
            id: id.into(),
            directory: fs::canonicalize(crate::profiles::profile_dir(&root, id)).unwrap(),
            launch_id: Uuid::new_v4(),
        };
        let source = worker("source");
        let target = worker("target");
        (
            root,
            source,
            target,
            Window {
                label: "main".into(),
                note_id: None,
                x: 143,
                y: 87,
                width: 1000,
                height: 700,
                visible: false,
                minimized: false,
                maximized: false,
            },
        )
    }

    #[test]
    fn journal_requires_ordered_close_and_never_replays_a_terminal_intent() {
        let (root, source, target, geometry) = fixture();
        let record = prepare(
            &root,
            Uuid::new_v4(),
            source.clone(),
            target.clone(),
            geometry.clone(),
        )
        .unwrap();
        assert!(prepare(
            &root,
            Uuid::new_v4(),
            source.clone(),
            target.clone(),
            geometry.clone()
        )
        .is_err());
        assert!(advance(&root, record.operation_id, Phase::Closed).is_err());
        assert!(advance(&root, Uuid::new_v4(), Phase::Closing).is_err());
        advance(&root, record.operation_id, Phase::Closing).unwrap();
        advance(&root, record.operation_id, Phase::Closed).unwrap();
        assert!(advance(&root, record.operation_id, Phase::Cancelled).is_err());
        advance(&root, record.operation_id, Phase::Completed).unwrap();
        assert!(!load(&root).unwrap().unwrap().active());
        assert!(advance(&root, record.operation_id, Phase::Closing).is_err());
        prepare(&root, Uuid::new_v4(), source, target, geometry).unwrap();
        assert!(root
            .join(format!(".vault-handoff-{}.json", record.operation_id))
            .is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_foreign_and_changed_physical_vault_evidence_is_retained() {
        let (root, source, target, geometry) = fixture();
        let record = prepare(&root, Uuid::new_v4(), source, target, geometry).unwrap();
        fs::write(root.join(FILE), b"corrupt").unwrap();
        assert!(load(&root).is_err());
        assert_eq!(fs::read(root.join(FILE)).unwrap(), b"corrupt");
        fs::write(root.join(FILE), serde_json::to_vec(&record).unwrap()).unwrap();
        let foreign = root.join("foreign");
        fs::create_dir(&foreign).unwrap();
        fs::write(foreign.join(FILE), serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(load(&foreign).is_err());
        fs::remove_dir(crate::profiles::profile_dir(&root, "target")).unwrap();
        assert!(record.verify_paths(&root).is_err());
        assert!(load(&root).unwrap().unwrap().active());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unresumable_intents_are_set_aside_and_moved_tombstones_stay_readable() {
        let (root, source, target, geometry) = fixture();
        let record = prepare(&root, Uuid::new_v4(), source, target, geometry).unwrap();
        assert!(quarantine_unresumable(&root).unwrap().is_none());
        let moved = root.with_file_name(format!("ms-handoff-moved-{}", Uuid::new_v4()));
        fs::rename(&root, &moved).unwrap();
        assert!(load(&moved).is_err());
        let evidence = quarantine_unresumable(&moved).unwrap().unwrap();
        assert_eq!(
            serde_json::from_slice::<Record>(&fs::read(evidence).unwrap()).unwrap(),
            record
        );
        assert!(load(&moved).unwrap().is_none());
        assert!(quarantine_unresumable(&moved).unwrap().is_none());

        let mut terminal = record;
        terminal.phase = Phase::Completed;
        fs::write(moved.join(FILE), serde_json::to_vec(&terminal).unwrap()).unwrap();
        assert!(!load(&moved).unwrap().unwrap().active());
        assert!(quarantine_unresumable(&moved).unwrap().is_none());
        assert!(abandon(&moved).unwrap().is_some());
        assert!(abandon(&moved).unwrap().is_none());
        fs::write(moved.join(FILE), b"corrupt").unwrap();
        assert!(quarantine_unresumable(&moved).unwrap().is_some());
        assert!(!moved.join(FILE).exists());
        fs::remove_dir_all(moved).unwrap();
    }
}
