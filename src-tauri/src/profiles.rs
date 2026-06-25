//! User profiles: the index of vaults and the active-profile resolution
//! that runs at boot.
//!
//! Each profile is a self-contained directory under
//! `<app_data_root>/profiles/<id>/` holding its own `mindstream.db`,
//! Etebase session, settings, backups and import staging — everything
//! that flows through [`crate::paths::app_data_dir`]. A small
//! `profiles.json` index lives at the **fixed** OS app-data root (the
//! one place stable across profiles) and records which profiles exist
//! and which one is active.
//!
//! Boot reads this index *before* the per-profile directory is known,
//! resolves the active profile's directory, and only then opens the DB.
//! Upgrades from the pre-profiles single-vault layout are handled by
//! [`migrate_legacy_if_needed`], which relocates the existing root-level
//! `mindstream.db` (and its siblings) into a `"default"` profile so no
//! one's notes get orphaned.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Id of the profile the legacy single vault migrates into. Kept as a
/// readable literal (not a uuid) because it doubles as the keyring
/// back-compat key in [`crate::auth`].
pub const DEFAULT_PROFILE_ID: &str = "default";

const INDEX_FILE: &str = "profiles.json";
const PROFILES_SUBDIR: &str = "profiles";
/// The live DB filename — its presence at the root is what marks a
/// pre-profiles install in need of migration.
const LEGACY_DB_FILE: &str = "mindstream.db";

/// One profile in the index. `name` is the user-facing label (lifecycle
/// commands edit it later); `id` is the stable directory + keyring key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub created_at: String,
}

/// The `profiles.json` document. `active` is the id of the profile boot
/// should open; it always refers to an entry in `profiles`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Index {
    pub active: String,
    pub profiles: Vec<Profile>,
}

impl Index {
    /// A fresh index with a single active "Default" profile. Used for
    /// brand-new installs and as the post-migration index.
    fn default_single() -> Self {
        Index {
            active: DEFAULT_PROFILE_ID.to_string(),
            profiles: vec![Profile {
                id: DEFAULT_PROFILE_ID.to_string(),
                name: "Default".to_string(),
                created_at: chrono::Utc::now().to_rfc3339(),
            }],
        }
    }
}

fn index_path(root: &Path) -> PathBuf {
    root.join(INDEX_FILE)
}

/// `<root>/profiles` — parent of every per-profile directory.
fn profiles_dir(root: &Path) -> PathBuf {
    root.join(PROFILES_SUBDIR)
}

/// The on-disk directory for a given profile id.
pub fn profile_dir(root: &Path, id: &str) -> PathBuf {
    profiles_dir(root).join(id)
}

/// Read the index if it exists. `Ok(None)` means no index file yet
/// (brand-new install or a pre-migration legacy layout).
pub fn load(root: &Path) -> AppResult<Option<Index>> {
    let path = index_path(root);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read(&path)?;
    let index: Index = serde_json::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("profiles index corrupt: {e}")))?;
    Ok(Some(index))
}

/// Persist the index to `<root>/profiles.json` (pretty-printed). Creates
/// the root directory if it doesn't exist yet.
pub fn save(root: &Path, index: &Index) -> AppResult<()> {
    fs::create_dir_all(root)?;
    let json = serde_json::to_vec_pretty(index)
        .map_err(|e| AppError::InvalidArg(format!("serialize profiles index: {e}")))?;
    fs::write(index_path(root), json)?;
    Ok(())
}

/// Load the index, creating a fresh single-"Default"-profile index on
/// first run if none exists.
pub fn load_or_init(root: &Path) -> AppResult<Index> {
    if let Some(index) = load(root)? {
        return Ok(index);
    }
    let index = Index::default_single();
    save(root, &index)?;
    Ok(index)
}

/// Legacy entries to relocate when upgrading a pre-profiles install. The
/// `mindstream*` prefix sweeps the DB trio (`mindstream.db`, `-wal`,
/// `-shm`) plus any `mindstream-pre-restore-*.db` safety copies.
const LEGACY_ENTRIES: &[&str] = &[
    "etebase.session",
    "desktop-settings.json",
    "pending-restore.db",
    "pending-restore.flag",
    "backups",
    "imports",
];

fn is_legacy_entry(name: &str) -> bool {
    name.starts_with("mindstream") || LEGACY_ENTRIES.contains(&name)
}

/// On upgrade from the single-vault layout, move the existing root-level
/// vault into `profiles/default/` so its notes aren't orphaned, then
/// write the index. No-op when an index already exists (already on the
/// profiles layout) or when there's no legacy DB (brand-new install —
/// `load_or_init` writes the fresh index instead).
///
/// Returns `true` when a migration actually ran. Crash-safe-ish: each
/// entry is moved only when the destination doesn't already hold it, so
/// a half-finished migration can be re-run.
pub fn migrate_legacy_if_needed(root: &Path) -> AppResult<bool> {
    if index_path(root).exists() {
        return Ok(false);
    }
    if !root.join(LEGACY_DB_FILE).exists() {
        return Ok(false);
    }

    let dest = profile_dir(root, DEFAULT_PROFILE_ID);
    fs::create_dir_all(&dest)?;

    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !is_legacy_entry(name) {
            continue;
        }
        let target = dest.join(name);
        if target.exists() {
            // Already migrated (re-run after a crash) — leave the source
            // in place rather than clobbering the destination.
            continue;
        }
        fs::rename(entry.path(), &target)?;
    }

    save(root, &Index::default_single())?;
    log::info!("[profiles] migrated legacy vault into profiles/{DEFAULT_PROFILE_ID}");
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ms-profiles-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn profile_dir_is_under_profiles_subdir() {
        let root = Path::new("/data");
        assert_eq!(
            profile_dir(root, "default"),
            Path::new("/data").join("profiles").join("default")
        );
    }

    #[test]
    fn load_or_init_writes_fresh_index_without_migrating() {
        let root = tmp_root();
        let index = load_or_init(&root).unwrap();
        assert_eq!(index.active, DEFAULT_PROFILE_ID);
        assert_eq!(index.profiles.len(), 1);
        assert!(index_path(&root).exists());
        // No legacy DB, so nothing should have been moved.
        assert!(!profile_dir(&root, DEFAULT_PROFILE_ID).exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn index_round_trips_through_save_and_load() {
        let root = tmp_root();
        let original = Index::default_single();
        save(&root, &original).unwrap();
        let loaded = load(&root).unwrap().unwrap();
        assert_eq!(loaded, original);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn migrate_moves_legacy_vault_into_default_profile() {
        let root = tmp_root();
        // Seed a pre-profiles install: the DB trio plus siblings.
        fs::write(root.join("mindstream.db"), b"db").unwrap();
        fs::write(root.join("mindstream.db-wal"), b"wal").unwrap();
        fs::write(root.join("mindstream.db-shm"), b"shm").unwrap();
        fs::write(root.join("etebase.session"), b"sess").unwrap();
        fs::write(root.join("desktop-settings.json"), b"{}").unwrap();
        fs::create_dir_all(root.join("backups")).unwrap();
        fs::write(root.join("backups").join("b.zip"), b"zip").unwrap();

        let migrated = migrate_legacy_if_needed(&root).unwrap();
        assert!(migrated);

        let dest = profile_dir(&root, DEFAULT_PROFILE_ID);
        for name in [
            "mindstream.db",
            "mindstream.db-wal",
            "mindstream.db-shm",
            "etebase.session",
            "desktop-settings.json",
        ] {
            assert!(dest.join(name).exists(), "{name} should move into profile");
            assert!(!root.join(name).exists(), "{name} should leave the root");
        }
        assert!(dest.join("backups").join("b.zip").exists());

        // A valid index now exists with a single active default profile.
        let index = load(&root).unwrap().unwrap();
        assert_eq!(index.active, DEFAULT_PROFILE_ID);
        assert_eq!(index.profiles.len(), 1);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn migrate_is_noop_when_index_already_exists() {
        let root = tmp_root();
        // Index present + a stray legacy db: must not migrate.
        save(&root, &Index::default_single()).unwrap();
        fs::write(root.join("mindstream.db"), b"db").unwrap();

        let migrated = migrate_legacy_if_needed(&root).unwrap();
        assert!(!migrated);
        // The legacy db stays put — we don't touch an already-migrated root.
        assert!(root.join("mindstream.db").exists());
        assert!(!profile_dir(&root, DEFAULT_PROFILE_ID)
            .join("mindstream.db")
            .exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn migrate_is_noop_for_brand_new_install() {
        let root = tmp_root();
        // No index, no legacy db.
        let migrated = migrate_legacy_if_needed(&root).unwrap();
        assert!(!migrated);
        assert!(!index_path(&root).exists());
        fs::remove_dir_all(&root).ok();
    }
}
