//! Root package catalog. Publication precedes catalog commit; OS leases keep
//! retired versions readable until every worker releases them.
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::discovery::{self, DiscoveredPlugin, PluginFiles};
use crate::error::{AppError, AppResult};
use crate::storage_locks::RootLock;

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    entries: BTreeMap<String, Installation>,
    /// Digests already imported from retained legacy directories, including
    /// removals. A retained source must never undo a device-wide uninstall.
    imported: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Installation {
    generation: Uuid,
    hash: Option<String>,
    legacy_generation: Uuid,
}

#[derive(Debug)]
pub struct PackageLease {
    file: Option<File>,
    root: PathBuf,
    hash: String,
}

impl Drop for PackageLease {
    fn drop(&mut self) {
        self.file.take();
        let root = self.root.clone();
        if !root.join("plugin-retired").join(&self.hash).exists() {
            return;
        }
        // Drop can occur under a catalog transaction. Reap outside it.
        let _ = std::thread::Builder::new()
            .name("plugin-package-reap".into())
            .spawn(move || {
                if let Ok(_lock) = RootLock::acquire(&root) {
                    if let Ok(catalog) = load(&root) {
                        let _ = collect_retired(&root, &catalog);
                    }
                }
            });
    }
}

fn revoked(root: &Path, generation: Uuid) -> bool {
    root.join("plugin-revocations")
        .join(generation.to_string())
        .exists()
}

fn input_receipt(directory: &Path, id: &str) -> AppResult<String> {
    Ok(format!("{}:{id}", directory.canonicalize()?.display()))
}

fn catalog_path(root: &Path) -> PathBuf {
    root.join("plugins/catalog.json")
}

fn parse(raw: &[u8]) -> AppResult<Catalog> {
    let catalog: Catalog = serde_json::from_slice(raw)
        .map_err(|e| AppError::InvalidArg(format!("plugin catalog: {e}")))?;
    for (id, entry) in &catalog.entries {
        super::safe_segment(id, "plugin id")?;
        if let Some(hash) = &entry.hash {
            if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err(AppError::InvalidArg("invalid package digest".into()));
            }
        }
    }
    Ok(catalog)
}

fn load(root: &Path) -> AppResult<Catalog> {
    for name in [
        "plugins",
        "plugin-packages",
        "plugin-leases",
        "plugin-retired",
        "plugin-revocations",
        "plugin-artifacts",
    ] {
        let path = root.join(name);
        if path.exists() && !path.canonicalize()?.starts_with(root.canonicalize()?) {
            return Err(AppError::InvalidArg(format!(
                "plugin directory escapes app root: {name}"
            )));
        }
        if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(AppError::InvalidArg(format!(
                "plugin directory is a symlink: {name}"
            )));
        }
    }
    let path = catalog_path(root);
    crate::root_documents::recover(
        &path,
        |raw| parse(raw).map(|_| ()),
        |raw| parse(raw).map(|_| ()),
    )?;
    match fs::read(path) {
        Ok(raw) => parse(&raw),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Catalog::default()),
        Err(e) => Err(e.into()),
    }
}

fn save(root: &Path, catalog: &Catalog) -> AppResult<()> {
    let raw =
        serde_json::to_vec_pretty(catalog).map_err(|e| AppError::InvalidArg(e.to_string()))?;
    crate::root_documents::write(&catalog_path(root), &raw, |raw| parse(raw).map(|_| ()))
}

fn lease_file(root: &Path, hash: &str) -> AppResult<File> {
    let dir = root.join("plugin-leases");
    fs::create_dir_all(&dir)?;
    Ok(OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join(format!("{hash}.lock")))?)
}

fn package_path(root: &Path, hash: &str) -> PathBuf {
    root.join("plugin-packages").join(hash)
}

fn storage_hash(plugin: &DiscoveredPlugin) -> AppResult<String> {
    let mut files = plugin.files.collect()?;
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let raw = serde_json::to_vec(&files).map_err(|e| AppError::InvalidArg(e.to_string()))?;
    Ok(super::sha256_hex(&raw))
}

pub(super) fn publish(root: &Path, plugin: &DiscoveredPlugin) -> AppResult<String> {
    let digest = storage_hash(plugin)?;
    let destination = package_path(root, &digest);
    if fs::symlink_metadata(&destination).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(AppError::InvalidArg(
            "package destination is a symlink".into(),
        ));
    }
    if destination.exists() {
        let existing =
            discovery::read_plugin(PluginFiles::Fs(destination), super::SOURCE_INSTALLED)?;
        if storage_hash(&existing)? != digest
            || existing.id != plugin.id
            || existing.checksum != plugin.checksum
            || existing.signer != plugin.signer
            || existing.signature_status != plugin.signature_status
        {
            return Err(AppError::InvalidArg(
                "immutable package was modified".into(),
            ));
        }
        return Ok(digest);
    }
    let staging = root
        .join("plugin-packages")
        .join(format!(".staging-{}", Uuid::new_v4()));
    fs::create_dir_all(&staging)?;
    for (rel, bytes) in plugin.files.collect()? {
        crate::atomic_file::write(&staging.join(rel), &bytes)?;
    }
    let copied = discovery::read_plugin(PluginFiles::Fs(staging.clone()), super::SOURCE_INSTALLED)?;
    if storage_hash(&copied)? != digest
        || copied.id != plugin.id
        || copied.checksum != plugin.checksum
        || copied.signer != plugin.signer
        || copied.signature_status != plugin.signature_status
    {
        return Err(AppError::InvalidArg(
            "package changed during publication; retry".into(),
        ));
    }
    fs::rename(&staging, destination)?;
    crate::atomic_file::sync_directory(&root.join("plugin-packages"))?;
    Ok(digest)
}

/// Called at startup with the selected vault before other workers launch.
/// Source bytes are retained as migration archives; receipts suppress reimport.
pub fn prepare(root: &Path, selected: &Path) -> AppResult<bool> {
    let _lock = RootLock::acquire(root)?;
    let mut catalog = load(root)?;
    let before = serde_json::to_vec(&catalog).map_err(|e| AppError::InvalidArg(e.to_string()))?;
    let existed = catalog_path(root).exists();
    let mut sources = vec![root.join("plugins"), selected.join("plugins")];
    if let Some(index) = crate::profiles::load(root)? {
        for entry in index.profiles {
            let path = crate::profiles::profile_dir(root, &entry.id).join("plugins");
            if !sources.contains(&path) {
                sources.push(path);
            }
        }
    }
    let builtin_ids: Vec<_> = discovery::discover_builtins()
        .into_iter()
        .map(|p| p.id)
        .collect();
    for source in &sources {
        for plugin in discovery::discover_dir(source, super::SOURCE_INSTALLED) {
            if builtin_ids.contains(&plugin.id) {
                continue;
            }
            let mut digest = storage_hash(&plugin)?;
            let receipt = input_receipt(source, &plugin.id)?;
            if catalog.imported.get(&receipt) == Some(&digest) {
                continue;
            }
            let root_input = *source == root.join("plugins");
            if root_input || !catalog.entries.contains_key(&plugin.id) {
                digest = publish(root, &plugin)?;
                let generation = catalog
                    .entries
                    .get(&plugin.id)
                    .filter(|entry| entry.hash.is_some() && !revoked(root, entry.generation))
                    .map(|entry| entry.generation)
                    .unwrap_or_else(Uuid::new_v4);
                let legacy_generation = catalog
                    .entries
                    .get(&plugin.id)
                    .map(|e| e.legacy_generation)
                    .unwrap_or(generation);
                catalog.entries.insert(
                    plugin.id.clone(),
                    Installation {
                        generation,
                        legacy_generation,
                        hash: Some(digest.clone()),
                    },
                );
            }
            catalog.imported.insert(receipt, digest);
        }
    }
    let changed = !existed
        || before
            != serde_json::to_vec(&catalog).map_err(|e| AppError::InvalidArg(e.to_string()))?;
    if changed {
        save(root, &catalog)?;
    }
    migrate_artifacts(root, &catalog, &sources)?;
    collect_retired(root, &catalog)?;
    Ok(changed)
}

fn migrate_artifacts(root: &Path, catalog: &Catalog, sources: &[PathBuf]) -> AppResult<()> {
    let mut plugins = discovery::discover_builtins();
    for entry in catalog.entries.values() {
        if revoked(root, entry.generation) {
            continue;
        }
        if let Some(hash) = &entry.hash {
            match discovery::read_plugin(
                PluginFiles::Fs(package_path(root, hash)),
                super::SOURCE_INSTALLED,
            ) {
                Ok(plugin) => plugins.push(plugin),
                Err(e) => log::warn!("[plugins] skipping unavailable package {hash}: {e}"),
            }
        }
    }
    for plugin in plugins {
        let destination = root.join("plugin-artifacts").join(&plugin.id);
        for artifact in &plugin.manifest.contributes.artifacts {
            if fs::read(super::artifact_path_in(&destination, artifact)?)
                .is_ok_and(|bytes| super::sha256_hex(&bytes) == artifact.sha256)
            {
                continue;
            }
            for source in sources {
                let vault = source
                    .parent()
                    .ok_or_else(|| AppError::InvalidArg("plugin source missing".into()))?;
                let legacy = vault
                    .join("plugin-artifacts")
                    .join(&plugin.id)
                    .join(&artifact.id)
                    .join(&artifact.version)
                    .join(&artifact.file_name);
                if let Ok(bytes) = fs::read(legacy) {
                    if super::sha256_hex(&bytes) == artifact.sha256 {
                        super::install_artifact_bytes(&destination, artifact, &bytes)?;
                        break;
                    }
                }
            }
        }
    }
    Ok(())
}

/// Explicit installation can republish identical bytes after removal. Updates
/// retain their generation; reinstallations always receive a fresh one.
pub fn install(root: &Path, source: &Path) -> AppResult<String> {
    if fs::symlink_metadata(source)?.file_type().is_symlink() {
        return Err(AppError::InvalidArg(
            "plugin directory cannot be a symlink".into(),
        ));
    }
    if !source.join("manifest.json").is_file() {
        return Err(AppError::InvalidArg(
            "select a plugin folder containing manifest.json".into(),
        ));
    }
    let plugin = discovery::read_plugin(
        PluginFiles::Fs(source.to_path_buf()),
        super::SOURCE_INSTALLED,
    )?;
    super::safe_segment(&plugin.id, "plugin id")?;
    if discovery::discover_builtins()
        .iter()
        .any(|p| p.id == plugin.id)
    {
        return Err(AppError::InvalidArg(
            "cannot replace a built-in plugin".into(),
        ));
    }
    let _lock = RootLock::acquire(root)?;
    let mut catalog = load(root)?;
    let digest = publish(root, &plugin)?;
    let previous = catalog.entries.get(&plugin.id);
    let generation = previous
        .filter(|entry| entry.hash.is_some() && !revoked(root, entry.generation))
        .map(|entry| entry.generation)
        .unwrap_or_else(Uuid::new_v4);
    let legacy_generation = previous
        .map(|entry| entry.legacy_generation)
        .unwrap_or(generation);
    catalog.entries.insert(
        plugin.id.clone(),
        Installation {
            generation,
            legacy_generation,
            hash: Some(digest.clone()),
        },
    );
    if let Some(parent) = source.parent() {
        // A folder selected from the legacy/root input tree is already
        // imported. An immediate remove must not race its next discovery.
        catalog
            .imported
            .insert(input_receipt(parent, &plugin.id)?, storage_hash(&plugin)?);
    }
    save(root, &catalog)?;
    collect_retired(root, &catalog)?;
    Ok(plugin.id)
}

pub fn is_global(directory: &Path) -> bool {
    directory.join("catalog.json").exists()
        || directory.join("catalog.json.previous").exists()
        || directory.parent().is_some_and(|root| {
            root.join("plugin-settings.json").exists() || root.join("plugin-packages").exists()
        })
}

/// Catalog lookup and lease acquisition share the root transaction with GC.
pub fn discover(directory: &Path, id: Option<&str>) -> AppResult<Vec<DiscoveredPlugin>> {
    let root = directory
        .parent()
        .ok_or_else(|| AppError::InvalidArg("plugin root missing".into()))?;
    let _lock = RootLock::acquire(root)?;
    let catalog = load(root)?;
    let mut plugins = Vec::new();
    for (plugin_id, entry) in catalog.entries {
        if id.is_some_and(|id| id != plugin_id) {
            continue;
        }
        if revoked(root, entry.generation) {
            continue;
        }
        let Some(hash) = entry.hash else {
            continue;
        };
        let lease = lease_file(root, &hash)?;
        lease
            .try_lock_shared()
            .map_err(|e| AppError::InvalidArg(format!("package busy: {e}")))?;
        let mut plugin = match discovery::read_plugin(
            PluginFiles::Fs(package_path(root, &hash)),
            super::SOURCE_INSTALLED,
        ) {
            Ok(plugin) => plugin,
            Err(e) if id.is_none() => {
                log::warn!("[plugins] skipping package {plugin_id}: {e}");
                continue;
            }
            Err(e) => return Err(e),
        };
        if plugin.id != plugin_id || storage_hash(&plugin)? != hash {
            if id.is_none() {
                log::warn!("[plugins] package {plugin_id} failed integrity verification");
                continue;
            }
            return Err(AppError::InvalidArg(
                "installed package integrity failure".into(),
            ));
        }
        plugin.generation = Some(entry.generation.to_string());
        plugin.legacy_generation = Some(entry.legacy_generation.to_string());
        plugin.lease = Some(Arc::new(PackageLease {
            file: Some(lease),
            root: root.to_path_buf(),
            hash,
        }));
        plugins.push(plugin);
    }
    Ok(plugins)
}

pub fn uninstall(root: &Path, id: &str) -> AppResult<()> {
    super::safe_segment(id, "plugin id")?;
    let _lock = RootLock::acquire(root)?;
    let mut catalog = load(root)?;
    if discovery::discover_builtins().iter().any(|p| p.id == id) {
        return Err(AppError::InvalidArg(format!(
            "cannot remove built-in plugin '{id}'"
        )));
    }
    if let Some(entry) = catalog.entries.get(id) {
        // An append-only revocation survives recovery of an older catalog.
        crate::atomic_file::write(
            &root
                .join("plugin-revocations")
                .join(entry.generation.to_string()),
            b"revoked",
        )?;
    }
    let generation = Uuid::new_v4();
    let legacy_generation = catalog
        .entries
        .get(id)
        .map(|e| e.legacy_generation)
        .unwrap_or(generation);
    catalog.entries.insert(
        id.into(),
        Installation {
            generation,
            legacy_generation,
            hash: None,
        },
    );
    save(root, &catalog)?;
    collect_retired(root, &catalog)
}

fn collect_retired(root: &Path, catalog: &Catalog) -> AppResult<()> {
    let dir = root.join("plugin-packages");
    if !dir.exists() {
        return collect_artifacts(root);
    }
    // Recovery needs the previous catalog's files. Revocation overrides both snapshots.
    let previous = match fs::read(root.join("plugins/catalog.json.previous")) {
        Ok(raw) => parse(&raw)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Catalog::default(),
        Err(e) => return Err(e.into()),
    };
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type()?.is_symlink() || !entry.file_type()?.is_dir() {
            continue;
        }
        if name.starts_with(".staging-") {
            fs::remove_dir_all(entry.path())?;
            continue;
        }
        if name.len() != 64 || !name.bytes().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        if catalog
            .entries
            .values()
            .chain(previous.entries.values())
            .any(|entry| !revoked(root, entry.generation) && entry.hash.as_deref() == Some(&name))
        {
            continue;
        }
        crate::atomic_file::write(&root.join("plugin-retired").join(&name), b"retired")?;
        let lease = lease_file(root, &name)?;
        if lease.try_lock().is_ok() {
            fs::remove_dir_all(entry.path())?;
        }
    }
    collect_artifacts(root)
}

fn collect_artifacts(root: &Path) -> AppResult<()> {
    let mut plugins = discovery::discover_builtins();
    let packages = root.join("plugin-packages");
    if packages.exists() {
        for entry in fs::read_dir(packages)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() || entry.file_type()?.is_symlink() {
                continue;
            }
            if let Ok(plugin) =
                discovery::read_plugin(PluginFiles::Fs(entry.path()), super::SOURCE_INSTALLED)
            {
                plugins.push(plugin);
            }
        }
    }
    let retained: std::collections::HashSet<_> = plugins
        .iter()
        .flat_map(|plugin| {
            plugin
                .manifest
                .contributes
                .artifacts
                .iter()
                .filter_map(|artifact| {
                    super::artifact_path_in(
                        &root.join("plugin-artifacts").join(&plugin.id),
                        artifact,
                    )
                    .ok()
                    .and_then(|path| path.parent().map(Path::to_path_buf))
                })
        })
        .collect();
    let artifacts = root.join("plugin-artifacts");
    if !artifacts.exists() {
        return Ok(());
    }
    // Only the new digest directories are managed. Retained legacy files and
    // unknown/conflicting source directories remain migration archives.
    let mut level = vec![artifacts];
    for depth in 0..4 {
        let mut next = Vec::new();
        for directory in level {
            for entry in fs::read_dir(directory)? {
                let entry = entry?;
                if !entry.file_type()?.is_dir() || entry.file_type()?.is_symlink() {
                    continue;
                }
                let path = entry.path();
                if depth == 3 {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.len() == 64
                        && name.bytes().all(|c| c.is_ascii_hexdigit())
                        && !retained.contains(&path)
                    {
                        fs::remove_dir_all(path)?;
                    }
                } else {
                    next.push(path);
                }
            }
        }
        level = next;
    }
    Ok(())
}

/// Existing vault approvals survive the first migration. A new installation
/// generation clears the old authority even when the bytes/signers match.
pub fn reconcile_generation(
    conn: &rusqlite::Connection,
    plugin: &DiscoveredPlugin,
) -> AppResult<()> {
    use rusqlite::OptionalExtension;
    let Some(generation) = &plugin.generation else {
        return Ok(());
    };
    let previous: Option<String> = conn
        .query_row(
            "SELECT generation FROM plugin_installations WHERE plugin_id = ?1",
            [&plugin.id],
            |row| row.get(0),
        )
        .optional()?;
    if previous
        .as_ref()
        .or(plugin.legacy_generation.as_ref())
        .is_some_and(|old| old != generation)
    {
        conn.execute(
            "UPDATE plugins SET enabled = 0, accepted_hash = '', signer = NULL,
            last_load_error = 'plugin was reinstalled; approval required' WHERE id = ?1",
            [&plugin.id],
        )?;
    }
    conn.execute(
        "INSERT INTO plugin_installations(plugin_id, generation) VALUES (?1, ?2)
        ON CONFLICT(plugin_id) DO UPDATE SET generation = excluded.generation",
        rusqlite::params![plugin.id, generation],
    )?;
    Ok(())
}

pub fn require_generation(conn: &rusqlite::Connection, plugin: &DiscoveredPlugin) -> AppResult<()> {
    use rusqlite::OptionalExtension;
    if let Some(generation) = &plugin.generation {
        let accepted: Option<String> = conn
            .query_row(
                "SELECT generation FROM plugin_installations WHERE plugin_id = ?1",
                [&plugin.id],
                |row| row.get(0),
            )
            .optional()?;
        if accepted.as_ref() != Some(generation) {
            return Err(AppError::InvalidArg(
                "plugin installation changed; discover and approve it again".into(),
            ));
        }
    }
    Ok(())
}
