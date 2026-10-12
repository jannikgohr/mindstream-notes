//! Root-owned recency and read-only selection of shortcut-eligible vaults.
//! This does not register with the OS or authorize a write to a selected vault.
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::storage_locks::RootLock;

const FILE: &str = "shortcut-recency.json";

/// Startup recency stays bound to the recorded physical directory, including
/// when the last-used vault is missing but another worker remains alive.
pub(crate) fn startup_order(root: &Path) -> AppResult<Vec<String>> {
    let _lock = RootLock::acquire(root)?;
    Ok(read(root)?
        .entries
        .into_iter()
        .rev()
        .filter_map(|entry| {
            let directory = crate::profiles::profile_dir(root, &entry.vault_id);
            std::fs::canonicalize(directory)
                .ok()
                .filter(|current| current == &entry.directory)
                .map(|_| entry.vault_id)
        })
        .collect())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    vault_id: String,
    directory: PathBuf,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Document {
    version: u32,
    entries: Vec<Entry>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum Selection {
    None,
    Target {
        vault_id: String,
        eligible: Vec<String>,
    },
}

fn invalid() -> AppError {
    AppError::InvalidArg("shortcut settings are unavailable; no destination selected".into())
}

fn decode(raw: &[u8]) -> AppResult<Document> {
    if raw.len() > 1024 * 1024 {
        return Err(invalid());
    }
    let doc: Document = serde_json::from_slice(raw).map_err(|_| invalid())?;
    let mut ids = BTreeSet::new();
    if doc.version != 1
        || doc.entries.len() > 4096
        || doc.entries.iter().any(|entry| {
            !crate::profiles::valid_id(&entry.vault_id)
                || !entry.directory.is_absolute()
                || !ids.insert(&entry.vault_id)
        })
    {
        return Err(invalid());
    }
    Ok(doc)
}

fn read(root: &Path) -> AppResult<Document> {
    match fs::read(root.join(FILE)) {
        Ok(raw) => decode(&raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if root.join(format!("{FILE}.previous")).try_exists()? {
                return Err(invalid());
            }
            Ok(Document {
                version: 1,
                entries: Vec::new(),
            })
        }
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn prepare(root: &Path) -> AppResult<()> {
    let _lock = RootLock::acquire(root)?;
    crate::root_documents::recover(
        &root.join(FILE),
        |raw| decode(raw).map(|_| ()),
        |raw| decode(raw).map(|_| ()),
    )?;
    read(root).map(|_| ())
}

/// The callback checks the native focus generation after taking RootLock.
/// Every vault focus is remembered, so a later eligibility change uses actual
/// recency rather than whichever worker happened to initialize first.
pub(crate) fn remember(
    root: &Path,
    vault_id: &str,
    is_current: impl FnOnce() -> AppResult<bool>,
) -> AppResult<()> {
    let _lock = RootLock::acquire(root)?;
    if !is_current()? {
        return Ok(());
    }
    let index = crate::profiles::load(root)?.ok_or_else(invalid)?;
    if !index.profiles.iter().any(|vault| vault.id == vault_id) {
        return Err(invalid());
    }
    let directory = fs::canonicalize(crate::profiles::profile_dir(root, vault_id))?;
    let mut doc = read(root)?;
    // Drop deleted/replaced vault identities without creating directories.
    doc.entries.retain(|entry| {
        entry.vault_id != vault_id
            && index
                .profiles
                .iter()
                .any(|vault| vault.id == entry.vault_id)
    });
    doc.entries.push(Entry {
        vault_id: vault_id.into(),
        directory,
    });
    let raw = serde_json::to_vec_pretty(&doc).map_err(|_| invalid())?;
    crate::root_documents::write(&root.join(FILE), &raw, |raw| decode(raw).map(|_| ()))
}

pub(crate) fn select(root: &Path, live_recency: &[String]) -> AppResult<Selection> {
    select_with_directory(root, live_recency).map(|(selection, _)| selection)
}

pub(crate) fn select_with_directory(
    root: &Path,
    live_recency: &[String],
) -> AppResult<(Selection, Option<PathBuf>)> {
    let _lock = RootLock::acquire(root)?;
    select_locked(root, live_recency)
}

/// Caller holds RootLock, including any final coordinator admission decision.
pub(crate) fn select_locked(
    root: &Path,
    live_recency: &[String],
) -> AppResult<(Selection, Option<PathBuf>)> {
    let index = crate::profiles::load(root)?.ok_or_else(invalid)?;
    let doc = read(root)?;
    let mut eligible = Vec::new();
    for vault in &index.profiles {
        let directory = crate::profiles::profile_dir(root, &vault.id);
        // In-progress deletion never becomes a capture destination.
        if directory.join(".vault-deleting").try_exists()? {
            continue;
        }
        if crate::ui_settings::shortcut_eligible(root, &vault.id, &directory)? {
            eligible.push(Entry {
                vault_id: vault.id.clone(),
                directory: fs::canonicalize(directory)?,
            });
        }
    }
    // Native focus is immediate in Book; its queued disk write may not have
    // finished when a shortcut arrives. Persisted history supplies the fallback
    // after restart, and live history keeps closed capture vaults in recency.
    let chosen = live_recency
        .iter()
        .rev()
        .find_map(|id| eligible.iter().find(|entry| &entry.vault_id == id))
        .or_else(|| {
            doc.entries.iter().rev().find_map(|recent| {
                eligible.iter().find(|entry| {
                    entry.vault_id == recent.vault_id && entry.directory == recent.directory
                })
            })
        })
        .or_else(|| eligible.iter().find(|entry| entry.vault_id == index.active))
        .or_else(|| eligible.first());
    let directory = chosen.map(|entry| entry.directory.clone());
    Ok((
        match chosen {
            None => Selection::None,
            Some(entry) => Selection::Target {
                vault_id: entry.vault_id.clone(),
                eligible: eligible.into_iter().map(|entry| entry.vault_id).collect(),
            },
        },
        directory,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("ms-shortcuts-{}", uuid::Uuid::new_v4()));
            let fixture = Self(root);
            for id in ["a", "b", "disabled"] {
                let directory = crate::profiles::profile_dir(&fixture.0, id);
                fs::create_dir_all(&directory).unwrap();
                fixture.enable(id, false);
            }
            let index = crate::profiles::Index {
                active: "disabled".into(),
                profiles: ["a", "b", "disabled"]
                    .into_iter()
                    .map(|id| crate::profiles::Profile {
                        id: id.into(),
                        name: id.into(),
                        created_at: "2026-10-11T00:00:00Z".into(),
                    })
                    .collect(),
            };
            fs::write(
                fixture.0.join("profiles.json"),
                serde_json::to_vec(&index).unwrap(),
            )
            .unwrap();
            fixture
        }
        fn enable(&self, id: &str, enabled: bool) {
            fs::write(
                crate::profiles::profile_dir(&self.0, id).join("content-settings.json"),
                serde_json::to_vec(&serde_json::json!({"version":1,"revision":1,
                    "values":{"hotkeys.globalShortcuts":enabled}}))
                .unwrap(),
            )
            .unwrap();
        }
        fn target(&self) -> Option<String> {
            match select(&self.0, &[]).unwrap() {
                Selection::None => None,
                Selection::Target { vault_id, .. } => Some(vault_id),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn one_enabled_closed_vault_wins_over_disabled_foreground_and_zero_selects_none() {
        let fixture = Fixture::new();
        remember(&fixture.0, "disabled", || Ok(true)).unwrap();
        assert_eq!(fixture.target(), None);
        fixture.enable("a", true);
        assert_eq!(fixture.target().as_deref(), Some("a"));
        fixture.enable("a", false);
        assert_eq!(fixture.target(), None);
    }

    #[test]
    fn eligible_recency_survives_restart_and_stale_focus_cannot_change_it() {
        let fixture = Fixture::new();
        fixture.enable("a", true);
        fixture.enable("b", true);
        remember(&fixture.0, "a", || Ok(true)).unwrap();
        remember(&fixture.0, "b", || Ok(true)).unwrap();
        remember(&fixture.0, "disabled", || Ok(true)).unwrap();
        prepare(&fixture.0).unwrap();
        assert_eq!(fixture.target().as_deref(), Some("b"));
        remember(&fixture.0, "a", || Ok(false)).unwrap();
        assert_eq!(fixture.target().as_deref(), Some("b"));
        fixture.enable("b", false);
        assert_eq!(fixture.target().as_deref(), Some("a"));
        fixture.enable("b", true);
        assert_eq!(fixture.target().as_deref(), Some("b"));
    }

    #[test]
    fn corrupt_vault_settings_are_not_repaired_or_rerouted_and_deleting_target_is_excluded() {
        let fixture = Fixture::new();
        fixture.enable("a", true);
        fixture.enable("b", true);
        remember(&fixture.0, "a", || Ok(true)).unwrap();
        let directory = crate::profiles::profile_dir(&fixture.0, "a");
        fs::write(directory.join("content-settings.json"), b"corrupt evidence").unwrap();
        assert!(select(&fixture.0, &[]).is_err());
        assert_eq!(
            fs::read(directory.join("content-settings.json")).unwrap(),
            b"corrupt evidence"
        );
        fs::write(directory.join(".vault-deleting"), b"pending deletion").unwrap();
        assert_eq!(fixture.target().as_deref(), Some("b"));
    }

    #[test]
    fn live_focus_wins_before_disk_flush_and_keeps_a_closed_eligible_vault() {
        let fixture = Fixture::new();
        fixture.enable("a", true);
        fixture.enable("b", true);
        remember(&fixture.0, "a", || Ok(true)).unwrap();
        let selection = select(&fixture.0, &["b".into(), "disabled".into()]).unwrap();
        assert!(matches!(selection, Selection::Target { vault_id, .. } if vault_id == "b"));
    }

    #[test]
    fn wrong_physical_recency_and_unrecoverable_history_do_not_redirect_capture() {
        let fixture = Fixture::new();
        fixture.enable("a", true);
        fixture.enable("b", true);
        let doc = Document {
            version: 1,
            entries: vec![Entry {
                vault_id: "b".into(),
                directory: fs::canonicalize(crate::profiles::profile_dir(&fixture.0, "a")).unwrap(),
            }],
        };
        fs::write(fixture.0.join(FILE), serde_json::to_vec(&doc).unwrap()).unwrap();
        assert_eq!(fixture.target().as_deref(), Some("a"));
        fs::write(fixture.0.join(FILE), b"unrecoverable evidence").unwrap();
        assert!(prepare(&fixture.0).is_err());
        assert!(select(&fixture.0, &["b".into()]).is_err());
        assert_eq!(
            fs::read(fixture.0.join(FILE)).unwrap(),
            b"unrecoverable evidence"
        );
    }

    #[test]
    fn corrupted_recency_recovers_previous_copy_only_during_coordinator_startup() {
        let fixture = Fixture::new();
        fixture.enable("a", true);
        fixture.enable("b", true);
        remember(&fixture.0, "a", || Ok(true)).unwrap();
        remember(&fixture.0, "b", || Ok(true)).unwrap();
        fs::write(fixture.0.join(FILE), b"corrupt recency").unwrap();
        assert!(select(&fixture.0, &[]).is_err());
        prepare(&fixture.0).unwrap();
        assert_eq!(fixture.target().as_deref(), Some("a"));
        assert!(fs::read_dir(&fixture.0)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("shortcut-recency.json.corrupt-")));
    }
}
