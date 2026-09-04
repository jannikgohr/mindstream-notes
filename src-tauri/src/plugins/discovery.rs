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
//! Integrity uses SHA-256 of the plugin's **package digest** (see
//! [`signing::package_digest`]) — a document folding in a content hash of every
//! file in the plugin dir, not just `manifest.json`. So any change to the
//! manifest *or* a `.luau` script re-triggers approval, and the hash can't be
//! forged to match a previously-approved package.

use std::collections::HashSet;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use include_dir::{include_dir, Dir};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use super::signing;
use super::{SOURCE_BUILTIN, SOURCE_INSTALLED};
use crate::error::{AppError, AppResult};

/// A plugin found on disk, with its trust `source` fixed by its location.
#[derive(Debug)]
pub struct DiscoveredPlugin {
    pub id: String,
    pub version: String,
    pub permissions: Vec<String>,
    /// Builtin plugins are enabled on first discovery unless this is false.
    /// Installed plugins ignore it and always start gated/disabled.
    pub enabled_by_default: bool,
    pub source: String,
    /// Where the plugin's files are read from — a real directory (third-party)
    /// or the binary-embedded builtin tree — used later to load its `.luau`
    /// entry, docs and icons.
    pub files: PluginFiles,
    /// SHA-256 (hex) of the raw manifest.json bytes.
    pub checksum: String,
    /// Signer fingerprint from `signature.json`, if the signature is valid.
    pub signer: Option<String>,
    /// `"unsigned"` | `"valid"` | `"invalid"`.
    pub signature_status: String,
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

/// The builtin plugins, embedded into the binary at compile time from the
/// repo-root `plugins/` tree.
///
/// Reading builtins from here rather than a bundled on-disk resource is what
/// makes them work on Android/iOS — where packaged resources live inside the app
/// bundle and aren't reachable through the filesystem — and it keeps their trust
/// intact: the bytes ship *inside* the signed binary, so no user-writable
/// location is ever treated as `builtin`.
static BUILTIN_PLUGINS: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../plugins");

/// Where a discovered plugin's files come from.
///
/// `Fs` is a real, user-writable directory (installed third-party plugins).
/// `Embedded` is a subtree of [`BUILTIN_PLUGINS`], compiled into the binary —
/// authentic by construction and readable on every platform, mobile included.
#[derive(Clone, Debug)]
pub enum PluginFiles {
    Fs(PathBuf),
    Embedded(&'static Dir<'static>),
}

impl PluginFiles {
    /// Every file under the plugin as `(relpath, bytes)`, `/`-separated. Order is
    /// unspecified — [`signing::package_digest`] sorts.
    fn collect(&self) -> AppResult<Vec<(String, Vec<u8>)>> {
        match self {
            PluginFiles::Fs(dir) => collect_files(dir),
            PluginFiles::Embedded(dir) => Ok(collect_files_embedded(dir)),
        }
    }

    /// Raw bytes of one relative file (a `.wasm`, `signature.json`, …), guarded
    /// against path traversal. `None` = the file isn't present.
    pub fn read_bytes(&self, rel: &str) -> AppResult<Option<Vec<u8>>> {
        if rel.contains("..") || rel.contains('\\') || rel.starts_with('/') {
            return Err(AppError::InvalidArg(format!(
                "unsafe plugin file path '{rel}'"
            )));
        }
        match self {
            PluginFiles::Fs(dir) => {
                let base = dir.canonicalize().unwrap_or_else(|_| dir.clone());
                match dir.join(rel).canonicalize() {
                    Ok(resolved) => {
                        if !resolved.starts_with(&base) {
                            return Err(AppError::InvalidArg(format!(
                                "plugin file path '{rel}' escapes the plugin dir"
                            )));
                        }
                        Ok(Some(fs::read(&resolved)?))
                    }
                    Err(_) => Ok(None),
                }
            }
            PluginFiles::Embedded(dir) => Ok(dir
                .get_file(dir.path().join(rel))
                .map(|f| f.contents().to_vec())),
        }
    }

    /// Text of one relative file (docs, icons, the entry script), guarded against
    /// path traversal. `None` = the file isn't present, so a caller can fall back
    /// (e.g. from a missing locale variant to the base file).
    pub fn read_text(&self, rel: &str) -> AppResult<Option<String>> {
        // Reject traversal up front for either backing (defense in depth; the
        // manifest validator also enforces safe relative paths).
        if rel.contains("..") || rel.contains('\\') || rel.starts_with('/') {
            return Err(AppError::InvalidArg(format!(
                "unsafe plugin file path '{rel}'"
            )));
        }
        match self {
            PluginFiles::Fs(dir) => {
                let base = dir.canonicalize().unwrap_or_else(|_| dir.clone());
                match dir.join(rel).canonicalize() {
                    Ok(resolved) => {
                        if !resolved.starts_with(&base) {
                            return Err(AppError::InvalidArg(format!(
                                "plugin file path '{rel}' escapes the plugin dir"
                            )));
                        }
                        Ok(Some(fs::read_to_string(&resolved)?))
                    }
                    // Missing / unresolvable → absent, not an error.
                    Err(_) => Ok(None),
                }
            }
            PluginFiles::Embedded(_) => Ok(self
                .read_bytes(rel)?
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())),
        }
    }

    /// Every `.luau` file in the plugin as a `module path (no extension) →
    /// source` map, for the plugin-scoped `require`. Keys are `/`-separated
    /// (e.g. `lib/parser`); non-UTF-8 files are skipped.
    pub fn luau_modules(&self) -> AppResult<std::collections::HashMap<String, String>> {
        let mut modules = std::collections::HashMap::new();
        for (rel, bytes) in self.collect()? {
            if let Some(stem) = rel.strip_suffix(".luau") {
                if let Ok(source) = String::from_utf8(bytes) {
                    modules.insert(stem.to_string(), source);
                }
            }
        }
        Ok(modules)
    }

    /// The real directory when filesystem-backed (for removal); `None` for
    /// embedded builtins, which can't be removed.
    pub fn fs_path(&self) -> Option<&Path> {
        match self {
            PluginFiles::Fs(dir) => Some(dir),
            PluginFiles::Embedded(_) => None,
        }
    }
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

/// Recursively read every file under `dir` as `(relpath, bytes)`, with `/`
/// separators. Order is unspecified — [`signing::package_digest`] sorts.
fn collect_files(dir: &Path) -> AppResult<Vec<(String, Vec<u8>)>> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(cur) = stack.pop() {
        for entry in fs::read_dir(&cur)?.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let rel = path
                .strip_prefix(dir)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            out.push((rel, fs::read(&path)?));
        }
    }
    Ok(out)
}

/// Read every file in an embedded plugin subtree as `(relpath, bytes)`, with
/// paths relative to `dir` and `/` separators — matching [`collect_files`] so a
/// builtin's package digest is byte-identical whether read from disk or the
/// binary.
fn collect_files_embedded(dir: &Dir<'static>) -> Vec<(String, Vec<u8>)> {
    fn walk(dir: &Dir<'static>, base: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        for file in dir.files() {
            let rel = file
                .path()
                .strip_prefix(base)
                .unwrap_or_else(|_| file.path())
                .to_string_lossy()
                .replace('\\', "/");
            out.push((rel, file.contents().to_vec()));
        }
        for sub in dir.dirs() {
            walk(sub, base, out);
        }
    }
    let mut out = Vec::new();
    walk(dir, dir.path(), &mut out);
    out
}

/// Read one plugin directory into a [`DiscoveredPlugin`]. The integrity checksum
/// and signature both cover the whole package (manifest + code + assets) via the
/// [`signing::package_digest`] document, not just `manifest.json`.
fn read_plugin(files: PluginFiles, source: &str) -> AppResult<DiscoveredPlugin> {
    let all = files.collect()?;
    let digest = signing::package_digest(&all);
    let checksum = sha256_hex(&digest);
    // Signature is verified over the package digest. Absent → unsigned.
    let sig_json = files.read_bytes("signature.json")?;
    let verification = signing::verify(&digest, sig_json.as_deref());
    let manifest_bytes = all
        .iter()
        .find(|(path, _)| path == "manifest.json")
        .map(|(_, bytes)| bytes.as_slice())
        .ok_or_else(|| AppError::InvalidArg("plugin has no manifest.json".to_string()))?;
    let manifest: serde_json::Value = serde_json::from_slice(manifest_bytes)
        .map_err(|e| AppError::InvalidArg(format!("manifest.json: {e}")))?;
    let id = manifest
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::InvalidArg("manifest has no string id".to_string()))?
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
    let enabled_by_default = manifest
        .get("enabledByDefault")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    Ok(DiscoveredPlugin {
        id,
        version,
        permissions,
        enabled_by_default,
        source: source.to_string(),
        files,
        checksum,
        signer: verification.signer,
        signature_status: verification.status.as_str().to_string(),
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
        match read_plugin(PluginFiles::Fs(path.clone()), source) {
            Ok(plugin) => out.push(plugin),
            Err(e) => log::warn!("[plugins] skipping {}: {e}", path.display()),
        }
    }
    out
}

/// Discover the binary-embedded builtin plugins: every subdirectory of the
/// embedded `plugins/` tree that has a `manifest.json`. Authentic by
/// construction (they ship inside the signed binary), so unlike third-party
/// plugins they are never subject to the integrity gate.
pub fn discover_builtins() -> Vec<DiscoveredPlugin> {
    let mut out = Vec::new();
    for sub in BUILTIN_PLUGINS.dirs() {
        if sub.get_file(sub.path().join("manifest.json")).is_none() {
            continue;
        }
        match read_plugin(PluginFiles::Embedded(sub), SOURCE_BUILTIN) {
            Ok(plugin) => out.push(plugin),
            Err(e) => log::warn!("[plugins] skipping builtin {}: {e}", sub.path().display()),
        }
    }
    out
}

/// Discover builtin (embedded) then third-party (installed) plugins. Builtin ids
/// win: a third-party plugin whose id collides with a builtin is dropped so it
/// can neither shadow the builtin nor inherit its trust.
pub fn discover(third_party_dir: &Path) -> Vec<DiscoveredPlugin> {
    let mut plugins: Vec<DiscoveredPlugin> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for plugin in discover_builtins() {
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

/// Find one plugin by id across the builtin + third-party sets, applying the
/// same builtin-wins rule as [`discover`]. Returns the [`DiscoveredPlugin`]
/// (with its [`PluginFiles`]) so a caller can load the plugin's entry script.
pub fn find(third_party_dir: &Path, id: &str) -> Option<DiscoveredPlugin> {
    discover(third_party_dir).into_iter().find(|p| p.id == id)
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
    fn discovers_the_embedded_builtin_templates_plugin() {
        let plugins = discover_builtins();
        let tpl = plugins
            .iter()
            .find(|p| p.id == "com.mindstream.templates.core")
            .expect("the embedded Templates plugin is discovered");
        assert_eq!(tpl.source, SOURCE_BUILTIN);
        assert_eq!(tpl.checksum.len(), 64); // sha-256 hex
                                            // Its entry script is readable straight from the binary.
        let main = tpl
            .files
            .read_text("main.luau")
            .unwrap()
            .expect("main.luau is present");
        assert!(main.contains("newFromTemplate"));
    }

    #[test]
    fn embedded_read_text_rejects_traversal() {
        let tpl = discover_builtins()
            .into_iter()
            .find(|p| p.id == "com.mindstream.templates.core")
            .unwrap();
        assert!(tpl.files.read_text("../secret").is_err());
    }

    #[test]
    fn builtin_wins_id_collision_and_third_party_copy_is_dropped() {
        let third = tmp();
        // A third-party copy claiming the embedded builtin's id must be dropped:
        // the builtin wins so a copy can't shadow it or inherit its trust.
        write_plugin(&third, "templates", "com.mindstream.templates.core", "");
        let plugins = discover(&third);
        let matching: Vec<_> = plugins
            .iter()
            .filter(|p| p.id == "com.mindstream.templates.core")
            .collect();
        assert_eq!(matching.len(), 1, "only the builtin survives the collision");
        assert_eq!(matching[0].source, SOURCE_BUILTIN);
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

    #[test]
    fn checksum_covers_sibling_code_files() {
        // A tampered .luau file must change the integrity checksum even though
        // manifest.json is untouched — this is what the package digest buys.
        let root = tmp();
        write_plugin(&root, "p", "com.a.p", "");
        let entry = root.join("p").join("main.luau");
        fs::write(&entry, "return { render = function() return {} end }").unwrap();
        let before = discover_dir(&root, SOURCE_INSTALLED)[0].checksum.clone();
        fs::write(&entry, "return { render = function() os.exit() end }").unwrap();
        let after = discover_dir(&root, SOURCE_INSTALLED)[0].checksum.clone();
        assert_ne!(before, after);
        fs::remove_dir_all(&root).ok();
    }
}
