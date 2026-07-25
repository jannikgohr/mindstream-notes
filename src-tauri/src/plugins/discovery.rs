//! Filesystem plugin discovery — the trust boundary.
//!
//! A plugin's trust (`source`) is decided **solely by which directory it was
//! read from**, never by anything inside its manifest:
//!
//!   - `core-plugins/` under the app's bundled **resource dir** → `builtin`.
//!     These ship inside the (signed) app bundle and are trusted, so a shipped
//!     update to a core plugin is auto-approved (see `plugins::upsert`).
//!   - `plugins/` under the active profile's **app-data dir** → `installed`.
//!     User-writable third-party plugins, subject to the manifest hash-change
//!     re-approval gate.
//!
//! This is what stops a third-party plugin from abusing the auto-approve path:
//! it may copy a core plugin's `id`, `name`, or any field, but read from the
//! app-data dir it is `installed` and stays gated. And a third-party plugin
//! whose `id` collides with a bundled core plugin is dropped entirely (the core
//! plugin wins), so it can neither shadow nor inherit the core plugin's trust.
//!
//! Integrity uses SHA-256 of the raw manifest bytes: any change to an installed
//! plugin's manifest changes the hash and re-triggers approval, and the hash
//! can't be forged to match a previously-approved manifest.

use std::collections::HashSet;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use super::{SOURCE_BUILTIN, SOURCE_INSTALLED};
use crate::error::{AppError, AppResult};

/// A plugin found on disk, with its trust `source` fixed by its location.
pub struct DiscoveredPlugin {
    pub id: String,
    pub version: String,
    pub permissions: Vec<String>,
    pub source: String,
    /// SHA-256 (hex) of the raw manifest.json bytes.
    pub checksum: String,
    /// The parsed manifest, passed through to the frontend for validation.
    pub manifest: serde_json::Value,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// The bundled core-plugins directory (inside the app resource dir).
pub fn core_plugins_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| AppError::InvalidArg(format!("resource_dir: {e}")))?;
    Ok(resource_dir.join("core-plugins"))
}

/// The active profile's third-party plugins directory.
pub fn third_party_plugins_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(crate::paths::app_data_dir(app)?.join("plugins"))
}

/// Create the third-party plugins directory if absent (best-effort), so users
/// have a discoverable place to drop plugins.
pub fn ensure_third_party_dir(dir: &Path) {
    if let Err(e) = fs::create_dir_all(dir) {
        log::warn!("[plugins] could not create {}: {e}", dir.display());
    }
}

/// Read one plugin directory's `manifest.json` into a [`DiscoveredPlugin`].
fn read_plugin(dir: &Path, source: &str) -> AppResult<DiscoveredPlugin> {
    let bytes = fs::read(dir.join("manifest.json"))?;
    let checksum = sha256_hex(&bytes);
    let manifest: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::InvalidArg(format!("manifest.json in {}: {e}", dir.display())))?;
    let id = manifest
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            AppError::InvalidArg(format!("manifest in {} has no string id", dir.display()))
        })?
        .to_string();
    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let permissions = manifest
        .get("permissions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Ok(DiscoveredPlugin {
        id,
        version,
        permissions,
        source: source.to_string(),
        checksum,
        manifest,
    })
}

/// Discover every plugin directly under `root` (each subdir with a
/// `manifest.json`), tagging each with `source`. A missing root yields nothing;
/// a malformed manifest is logged and skipped.
pub fn discover_dir(root: &Path, source: &str) -> Vec<DiscoveredPlugin> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || !path.join("manifest.json").exists() {
            continue;
        }
        match read_plugin(&path, source) {
            Ok(plugin) => out.push(plugin),
            Err(e) => log::warn!("[plugins] skipping {}: {e}", path.display()),
        }
    }
    out
}

/// Discover core (builtin) then third-party (installed) plugins. Builtin ids
/// win: a third-party plugin whose id collides with a core plugin is dropped so
/// it can neither shadow the core plugin nor inherit its trust.
pub fn discover(core_dir: &Path, third_party_dir: &Path) -> Vec<DiscoveredPlugin> {
    let mut plugins: Vec<DiscoveredPlugin> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for plugin in discover_dir(core_dir, SOURCE_BUILTIN) {
        seen.insert(plugin.id.clone());
        plugins.push(plugin);
    }
    for plugin in discover_dir(third_party_dir, SOURCE_INSTALLED) {
        if seen.contains(&plugin.id) {
            log::warn!(
                "[plugins] third-party '{}' collides with a bundled core plugin id; ignored",
                plugin.id
            );
            continue;
        }
        seen.insert(plugin.id.clone());
        plugins.push(plugin);
    }
    plugins
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_plugin(root: &Path, name: &str, id: &str, extra: &str) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("manifest.json"),
            format!(
                r#"{{ "id": "{id}", "version": "1.0.0", "permissions": ["notes.create"]{extra} }}"#
            ),
        )
        .unwrap();
    }

    fn tmp() -> PathBuf {
        std::env::temp_dir().join(format!("ms-plugins-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn discover_dir_tags_source_and_hashes_manifest() {
        let root = tmp();
        write_plugin(&root, "templates", "com.a.templates", "");
        let found = discover_dir(&root, SOURCE_BUILTIN);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "com.a.templates");
        assert_eq!(found[0].source, SOURCE_BUILTIN);
        assert_eq!(found[0].checksum.len(), 64); // sha-256 hex
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_directory_yields_no_plugins() {
        assert!(discover_dir(&tmp(), SOURCE_INSTALLED).is_empty());
    }

    #[test]
    fn malformed_manifest_is_skipped() {
        let root = tmp();
        let dir = root.join("broken");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manifest.json"), "{ not json").unwrap();
        assert!(discover_dir(&root, SOURCE_INSTALLED).is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn source_is_by_location_not_manifest_claim() {
        // A third-party manifest that *claims* to be builtin is still installed:
        // discovery ignores any source-like field and tags by directory.
        let third = tmp();
        write_plugin(
            &third,
            "evil",
            "com.evil.plugin",
            r#", "source": "builtin""#,
        );
        let found = discover_dir(&third, SOURCE_INSTALLED);
        assert_eq!(found[0].source, SOURCE_INSTALLED);
        fs::remove_dir_all(&third).ok();
    }

    #[test]
    fn core_wins_id_collision_and_third_party_copy_is_dropped() {
        let core = tmp();
        let third = tmp();
        write_plugin(&core, "templates", "com.mindstream.templates.core", "");
        // Same id, dropped in the third-party dir — must be ignored.
        write_plugin(&third, "templates", "com.mindstream.templates.core", "");
        let plugins = discover(&core, &third);
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].source, SOURCE_BUILTIN);
        fs::remove_dir_all(&core).ok();
        fs::remove_dir_all(&third).ok();
    }

    #[test]
    fn checksum_changes_when_manifest_changes() {
        let root = tmp();
        write_plugin(&root, "p", "com.a.p", "");
        let before = discover_dir(&root, SOURCE_INSTALLED)[0].checksum.clone();
        write_plugin(&root, "p", "com.a.p", r#", "name": "Changed""#);
        let after = discover_dir(&root, SOURCE_INSTALLED)[0].checksum.clone();
        assert_ne!(before, after);
        fs::remove_dir_all(&root).ok();
    }
}
