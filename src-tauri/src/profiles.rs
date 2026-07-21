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

use crate::error::{AppError, AppResult};

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
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidArg("vault name cannot be empty".into()));
    }
    let mut index = load_or_init(root)?;
    let profile = Profile {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    fs::create_dir_all(profile_dir(root, &profile.id))?;
    index.profiles.push(profile.clone());
    save(root, &index)?;
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
    let mut index = load_or_init(root)?;
    if !index.profiles.iter().any(|p| p.id == id) {
        return Err(AppError::NotFound(format!("unknown vault: {id}")));
    }
    index.active = id.to_string();
    save(root, &index)?;
    log::info!("[profiles] active vault set to {id} (effective next launch)");
    Ok(())
}

/// Change a profile's display name (the on-disk id/dir never changes).
/// Trims and rejects an empty name; errors if `id` is unknown. Returns
/// the updated profile. Renaming the active vault is fine — it's only a
/// label, so no relaunch is needed.
pub fn set_name(root: &Path, id: &str, name: &str) -> AppResult<Profile> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidArg("vault name cannot be empty".into()));
    }
    let mut index = load_or_init(root)?;
    let profile = index
        .profiles
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| AppError::NotFound(format!("unknown vault: {id}")))?;
    profile.name = name.to_string();
    let updated = profile.clone();
    save(root, &index)?;
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
    let mut index = load_or_init(root)?;
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
    index.profiles.retain(|p| p.id != id);
    save(root, &index)?;

    let dir = profile_dir(root, id);
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    log::info!("[profiles] deleted vault {id}");
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
pub fn list_profiles(app: tauri::AppHandle) -> Result<ProfilesView, String> {
    use tauri::Manager;
    let root = crate::paths::app_data_root(&app).map_err(String::from)?;
    let index = load_or_init(&root).map_err(String::from)?;
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
pub fn create_profile(app: tauri::AppHandle, name: String) -> Result<Profile, String> {
    let root = crate::paths::app_data_root(&app).map_err(String::from)?;
    add_profile(&root, &name).map_err(String::from)
}

#[tauri::command]
pub fn switch_profile(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let root = crate::paths::app_data_root(&app).map_err(String::from)?;
    set_active(&root, &id).map_err(String::from)
}

#[tauri::command]
pub fn rename_profile(app: tauri::AppHandle, id: String, name: String) -> Result<Profile, String> {
    let root = crate::paths::app_data_root(&app).map_err(String::from)?;
    set_name(&root, &id, &name).map_err(String::from)
}

#[tauri::command]
pub fn delete_profile(app: tauri::AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager;
    let root = crate::paths::app_data_root(&app).map_err(String::from)?;
    let active = app
        .try_state::<crate::paths::ActiveProfile>()
        .map(|p| p.id.clone())
        .unwrap_or_else(|| DEFAULT_PROFILE_ID.to_string());
    delete(&root, &id, &active).map_err(String::from)?;
    // Best-effort: drop the deleted vault's keyring session so no stale
    // credential lingers after its files are gone.
    crate::auth::forget_profile_keyring(&id);
    Ok(())
}

#[cfg(test)]
mod tests;
