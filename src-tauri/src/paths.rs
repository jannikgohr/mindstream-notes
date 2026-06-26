//! Filesystem seam for the active user profile.
//!
//! Every call site that used to reach for `app.path().app_data_dir()`
//! funnels through [`app_data_dir`] instead. The returned directory is
//! the *active profile's* directory, not the raw OS app-data root — so
//! the DB, Etebase session, settings, backups and import staging all
//! relocate under the chosen profile automatically.
//!
//! Two distinct directories live here:
//!
//!   * [`app_data_root`] — the **fixed** OS `app_data_dir()`. Stable
//!     across profiles; this is where the `profiles.json` index lives
//!     and where the per-profile `profiles/<id>/` subdirectories hang
//!     off. Used at boot *before* a profile is known.
//!   * [`app_data_dir`] — the active profile directory, read from the
//!     managed [`ActiveProfile`] state. Used everywhere else.
//!
//! Boot order matters: `lib.rs` resolves the active profile and calls
//! `app.manage(ActiveProfile { .. })` before opening the DB or loading
//! desktop settings, so by the time any command runs the state is
//! present. As a defensive fallback, [`app_data_dir`] returns the OS
//! root if the state hasn't been managed yet.

use std::path::PathBuf;

use tauri::{Manager, Runtime};

use crate::error::{AppError, AppResult};

/// The directory the active profile reads and writes everything under.
/// Managed in Tauri state at boot. `dir` is an absolute path; `id` is
/// the profile identifier (`"default"` for the migrated single vault).
#[derive(Debug, Clone)]
pub struct ActiveProfile {
    pub id: String,
    pub dir: PathBuf,
}

/// The fixed OS app-data root (`%APPDATA%/<bundle>` etc.). Stable across
/// profiles — the `profiles.json` index and the `profiles/` tree both
/// live here. Boot code uses this before the active profile is resolved.
pub fn app_data_root<R: Runtime, M: Manager<R>>(manager: &M) -> AppResult<PathBuf> {
    manager
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidArg(format!("app_data_dir: {e}")))
}

/// The active profile's directory. Reads the managed [`ActiveProfile`];
/// falls back to [`app_data_root`] if the state isn't present yet (only
/// possible before boot's `app.manage`, which no command path hits).
pub fn app_data_dir<R: Runtime, M: Manager<R>>(manager: &M) -> AppResult<PathBuf> {
    match manager.try_state::<ActiveProfile>() {
        Some(profile) => Ok(profile.dir.clone()),
        None => app_data_root(manager),
    }
}
