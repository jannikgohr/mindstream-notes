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

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult, CommandResult};
use crate::storage_locks::{RootLock, VaultLock};

/// Env var pointing the active profile dir at an arbitrary path — the
/// e2e/test isolation seam. Honored only when [`dir_override_allowed`].
pub const PROFILE_DIR_ENV: &str = "MINDSTREAM_PROFILE_DIR";
/// Optional companion to [`PROFILE_DIR_ENV`] setting the profile id (and
/// hence the keyring namespace). Defaults to a non-"default" id so an
/// overridden run gets its own isolated keyring entry out of the box.
pub const PROFILE_ID_ENV: &str = "MINDSTREAM_PROFILE_ID";
const OVERRIDE_DEFAULT_ID: &str = "e2e";

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
    let raw = match fs::read(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };
    let index: Index = serde_json::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("profiles index corrupt: {e}")))?;
    validate_index(&index)?;
    Ok(Some(index))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn validate_index(index: &Index) -> AppResult<()> {
    let mut ids = std::collections::HashSet::new();
    if index.profiles.is_empty()
        || index
            .profiles
            .iter()
            .any(|profile| !valid_id(&profile.id) || !ids.insert(&profile.id))
        || !ids.contains(&index.active)
    {
        return Err(AppError::InvalidArg(
            "profiles index contains invalid, duplicate, or missing active vault IDs".into(),
        ));
    }
    Ok(())
}

/// Persist the index to `<root>/profiles.json` (pretty-printed). Creates
/// the root directory if it doesn't exist yet.
pub fn save(root: &Path, index: &Index) -> AppResult<()> {
    let _lock = RootLock::acquire(root)?;
    save_locked(root, index)
}

fn save_locked(root: &Path, index: &Index) -> AppResult<()> {
    validate_index(index)?;
    fs::create_dir_all(root)?;
    let json = serde_json::to_vec_pretty(index)
        .map_err(|e| AppError::InvalidArg(format!("serialize profiles index: {e}")))?;
    crate::atomic_file::write(&index_path(root), &json)?;
    Ok(())
}

/// Load the index, creating a fresh single-"Default"-profile index on
/// first run if none exists.
pub fn load_or_init(root: &Path) -> AppResult<Index> {
    let _lock = RootLock::acquire(root)?;
    load_or_init_locked(root)
}

fn load_or_init_locked(root: &Path) -> AppResult<Index> {
    reconcile_deletions(root)?;
    if let Some(index) = load(root)? {
        return Ok(index);
    }
    let index = Index::default_single();
    save_locked(root, &index)?;
    Ok(index)
}

/// Legacy entries to relocate when upgrading a pre-profiles install. The
/// `mindstream*` prefix sweeps the DB trio (`mindstream.db`, `-wal`,
/// `-shm`) plus any `mindstream-pre-restore-*.db` safety copies.
const LEGACY_ENTRIES: &[&str] = &[
    "etebase.session",
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
/// Returns `true` when a migration actually ran. Interrupted moves resume
/// before the index is published; conflicting source/destination files stop
/// migration and remain intact for recovery.
pub fn migrate_legacy_if_needed(root: &Path) -> AppResult<bool> {
    let _lock = RootLock::acquire(root)?;
    migrate_legacy_locked(root)
}

fn migrate_legacy_locked(root: &Path) -> AppResult<bool> {
    if index_path(root).exists() {
        return Ok(false);
    }
    let dest = profile_dir(root, DEFAULT_PROFILE_ID);
    if root.join(LEGACY_DB_FILE).try_exists()? && dest.join(LEGACY_DB_FILE).try_exists()? {
        return Err(AppError::InvalidArg(
            "both legacy and migrated databases exist; migration requires recovery".into(),
        ));
    }
    if !root.join(LEGACY_DB_FILE).try_exists()? && !dest.join(LEGACY_DB_FILE).try_exists()? {
        return Ok(false);
    }
    let _legacy_owner = if root.join(LEGACY_DB_FILE).try_exists()? {
        Some(VaultLock::acquire(root)?)
    } else {
        None
    };
    let _destination_owner = VaultLock::acquire(&dest)?;
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
        if target.try_exists()? {
            return Err(AppError::InvalidArg(format!(
                "legacy migration has conflicting copies of {name}; recovery required"
            )));
        }
        fs::rename(entry.path(), &target)?;
    }

    save_locked(root, &Index::default_single())?;
    log::info!("[profiles] migrated legacy vault into profiles/{DEFAULT_PROFILE_ID}");
    Ok(true)
}

/// Selection and ownership are one root transaction, including deletion recovery.
pub fn resolve_startup(root: &Path) -> AppResult<(String, VaultLock)> {
    let _lock = RootLock::acquire(root)?;
    reconcile_deletions(root)?;
    migrate_legacy_locked(root)?;
    let index = load_or_init_locked(root)?;
    let owner = VaultLock::acquire(&profile_dir(root, &index.active))?;
    Ok((index.active, owner))
}

/// Whether the data-dir env override is permitted in this build. Dev
/// builds (`debug_assertions`) and builds compiled with the
/// `e2e-data-dir` feature allow it; a production release build does not,
/// so a stray env var can never redirect a real user's vault.
pub fn dir_override_allowed() -> bool {
    cfg!(debug_assertions) || cfg!(feature = "e2e-data-dir")
}

/// Pure core of [`dir_override`]: given the raw env values and whether
/// the build gate is open, decide the overriding `(id, dir)`. `None`
/// means "no override — fall back to the index". Factored out so the
/// gating + defaulting logic is unit-testable without touching process
/// env or build cfg.
fn override_from_env(
    dir_env: Option<OsString>,
    id_env: Option<String>,
    allowed: bool,
) -> Option<(String, PathBuf)> {
    if !allowed {
        return None;
    }
    let dir = dir_env.filter(|v| !v.is_empty())?;
    let id = id_env
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| OVERRIDE_DEFAULT_ID.to_string());
    Some((id, PathBuf::from(dir)))
}

/// Resolve a gated env-var override of the active profile directory.
/// Returns `Some((id, dir))` to bypass the index entirely (used by the
/// e2e harness to isolate each run), or `None` to use the on-disk index.
pub fn dir_override() -> Option<(String, PathBuf)> {
    let over = override_from_env(
        std::env::var_os(PROFILE_DIR_ENV),
        std::env::var(PROFILE_ID_ENV).ok(),
        dir_override_allowed(),
    );
    if let Some((id, dir)) = &over {
        log::info!(
            "[profiles] data-dir override active: profile '{id}' -> {}",
            dir.display()
        );
    }
    over
}

// ---------- Lifecycle (create / switch) ----------

/// Add a new profile to the index and create its directory. The id is a
/// fresh uuid (names stay free-form and collision-free); the name is
/// trimmed and must be non-empty. Does **not** change the active
/// profile — the caller switches separately. Returns the new profile.
pub fn add_profile(root: &Path, name: &str) -> AppResult<Profile> {
    let _lock = RootLock::acquire(root)?;
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidArg("vault name cannot be empty".into()));
    }
    let mut index = load_or_init_locked(root)?;
    let profile = Profile {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    fs::create_dir_all(profile_dir(root, &profile.id))?;
    index.profiles.push(profile.clone());
    save_locked(root, &index)?;
    log::info!(
        "[profiles] created vault '{}' ({})",
        profile.name,
        profile.id
    );
    Ok(profile)
}

/// Mark `id` as the active profile. Errors if no such profile exists so
/// a stale id can't strand boot on a missing directory. The switch only
/// takes effect on the next launch — the caller relaunches.
pub fn set_active(root: &Path, id: &str) -> AppResult<()> {
    let _lock = RootLock::acquire(root)?;
    let mut index = load_or_init_locked(root)?;
    if !index.profiles.iter().any(|p| p.id == id) {
        return Err(AppError::NotFound(format!("unknown vault: {id}")));
    }
    index.active = id.to_string();
    save_locked(root, &index)?;
    log::info!("[profiles] active vault set to {id} (effective next launch)");
    Ok(())
}

/// Change a profile's display name (the on-disk id/dir never changes).
/// Trims and rejects an empty name; errors if `id` is unknown. Returns
/// the updated profile. Renaming the active vault is fine — it's only a
/// label, so no relaunch is needed.
pub fn set_name(root: &Path, id: &str, name: &str) -> AppResult<Profile> {
    let _lock = RootLock::acquire(root)?;
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidArg("vault name cannot be empty".into()));
    }
    let mut index = load_or_init_locked(root)?;
    let profile = index
        .profiles
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| AppError::NotFound(format!("unknown vault: {id}")))?;
    profile.name = name.to_string();
    let updated = profile.clone();
    save_locked(root, &index)?;
    log::info!("[profiles] renamed vault {id} to '{}'", updated.name);
    Ok(updated)
}

/// Permanently delete a profile: drop it from the index, then remove its
/// on-disk directory (notes DB, session, settings — everything).
///
/// Guards: refuses to delete the currently-loaded vault (`active_id` —
/// the running process has its DB open from there) and the last
/// remaining vault, so there's always something to boot into. The index
/// entry is removed before the files so a crash mid-delete leaves an
/// orphaned directory (harmless) rather than an index pointing at
/// missing data.
pub fn delete(root: &Path, id: &str, active_id: &str) -> AppResult<()> {
    let _lock = RootLock::acquire(root)?;
    let mut index = load_or_init_locked(root)?;
    if id == active_id || id == index.active {
        return Err(AppError::InvalidArg(
            "cannot delete the active vault — switch to another vault first".into(),
        ));
    }
    if !index.profiles.iter().any(|p| p.id == id) {
        return Err(AppError::NotFound(format!("unknown vault: {id}")));
    }
    if index.profiles.len() <= 1 {
        return Err(AppError::InvalidArg("cannot delete the last vault".into()));
    }
    let dir = profile_dir(root, id);
    let owner = if dir.try_exists()? {
        Some(checked_delete_owner(root, id)?)
    } else {
        None
    };
    let record = root.join(format!(".vault-delete-{id}.json"));
    crate::atomic_file::write(
        &record,
        &serde_json::to_vec(id).map_err(|err| AppError::InvalidArg(err.to_string()))?,
    )?;
    if let Some(owner) = &owner {
        crate::atomic_file::write(&owner.directory.join(".vault-deleting"), b"pending")?;
    }
    index.profiles.retain(|p| p.id != id);
    save_locked(root, &index)?;
    // Windows cannot delete the directory while its lock handle is held.
    drop(owner);
    if dir.try_exists()? {
        fs::remove_dir_all(&dir)?;
    }
    fs::remove_file(record)?;
    crate::atomic_file::sync_directory(root)?;
    log::info!("[profiles] deleted vault {id}");
    Ok(())
}

fn checked_delete_owner(root: &Path, id: &str) -> AppResult<VaultLock> {
    let directory = fs::canonicalize(profile_dir(root, id))?;
    let parent = fs::canonicalize(profiles_dir(root))?;
    if !directory.starts_with(&parent) || directory == parent {
        return Err(AppError::InvalidArg(
            "refusing to delete a vault outside the profiles directory".into(),
        ));
    }
    VaultLock::acquire_for_delete(&directory)
}

fn reconcile_deletions(root: &Path) -> AppResult<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(".vault-delete-") || !name.ends_with(".json") {
            continue;
        }
        let id: String = serde_json::from_slice(&fs::read(entry.path())?)
            .map_err(|err| AppError::InvalidArg(format!("vault deletion record corrupt: {err}")))?;
        if !valid_id(&id) || name != format!(".vault-delete-{id}.json") {
            return Err(AppError::InvalidArg("invalid vault deletion record".into()));
        }
        let dir = profile_dir(root, &id);
        let owner = if dir.try_exists()? {
            Some(checked_delete_owner(root, &id)?)
        } else {
            None
        };
        if let Some(mut index) = load(root)? {
            if index.profiles.iter().any(|profile| profile.id == id) {
                if index.profiles.len() <= 1 || index.active == id {
                    return Err(AppError::InvalidArg(
                        "ambiguous vault deletion record".into(),
                    ));
                }
                if let Some(owner) = &owner {
                    crate::atomic_file::write(
                        &owner.directory.join(".vault-deleting"),
                        b"pending",
                    )?;
                }
                index.profiles.retain(|profile| profile.id != id);
                save_locked(root, &index)?;
            }
        } else {
            return Err(AppError::InvalidArg(
                "vault index missing during deletion recovery".into(),
            ));
        }
        drop(owner);
        if dir.try_exists()? {
            fs::remove_dir_all(&dir)?;
        }
        fs::remove_file(entry.path())?;
        crate::atomic_file::sync_directory(root)?;
    }
    Ok(())
}

// ---------- Tauri commands ----------

/// What the frontend renders: the list of profiles plus both the **live**
/// active id (read from `ActiveProfile` state, so it stays correct even
/// when an env override diverges from the on-disk index) and the active
/// id persisted in `profiles.json`.
#[derive(Debug, Clone, Serialize)]
pub struct ProfilesView {
    pub active: String,
    pub index_active: String,
    pub profiles: Vec<Profile>,
}

#[tauri::command]
pub fn list_profiles(app: tauri::AppHandle) -> CommandResult<ProfilesView> {
    use tauri::Manager;
    let root = crate::paths::app_data_root(&app)?;
    let index = load_or_init(&root)?;
    let active = app
        .try_state::<crate::paths::ActiveProfile>()
        .map(|p| p.id.clone())
        .unwrap_or_else(|| index.active.clone());
    Ok(ProfilesView {
        active,
        index_active: index.active,
        profiles: index.profiles,
    })
}

#[tauri::command]
pub fn create_profile(app: tauri::AppHandle, name: String) -> CommandResult<Profile> {
    let root = crate::paths::app_data_root(&app)?;
    Ok(add_profile(&root, &name)?)
}

#[tauri::command]
pub fn switch_profile(app: tauri::AppHandle, id: String) -> CommandResult<()> {
    let root = crate::paths::app_data_root(&app)?;
    Ok(set_active(&root, &id)?)
}

#[tauri::command]
pub fn rename_profile(app: tauri::AppHandle, id: String, name: String) -> CommandResult<Profile> {
    let root = crate::paths::app_data_root(&app)?;
    Ok(set_name(&root, &id, &name)?)
}

#[tauri::command]
pub fn delete_profile(app: tauri::AppHandle, id: String) -> CommandResult<()> {
    use tauri::Manager;
    let root = crate::paths::app_data_root(&app)?;
    let active = app
        .try_state::<crate::paths::ActiveProfile>()
        .map(|p| p.id.clone())
        .unwrap_or_else(|| DEFAULT_PROFILE_ID.to_string());
    delete(&root, &id, &active)?;
    // Best-effort: drop the deleted vault's keyring session so no stale
    // credential lingers after its files are gone.
    crate::auth::forget_profile_keyring(&app, &id);
    Ok(())
}

#[cfg(test)]
mod tests;
