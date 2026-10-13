//! Portable values and immutable package bytes. No credentials, physical owners,
//! browser caches, installation generations or download caches cross devices.
use super::*;
use crate::storage_locks::RootLock;
use std::collections::{BTreeMap, BTreeSet};

pub(super) const PAYLOAD: &str = "portable.json";
pub(super) const PENDING: &str = "pending-restore-files";
const INDEX: &str = "resource-index.json";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PendingIndex {
    id: uuid::Uuid,
    index: Index,
}
const MAX_JSON: u64 = 4 * 1024 * 1024;
const MAX_TOTAL: u64 = 16 * 1024 * 1024 * 1024;
type Values = BTreeMap<String, serde_json::Value>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Index {
    pub files: Vec<Entry>,
    pub directories: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub mode: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    version: u32,
    vault_settings: Values,
    device_settings: Values,
    desktop_settings: serde_json::Value,
    device_plugin_settings: BTreeMap<String, Values>,
    device_plugin_keys: BTreeMap<String, BTreeSet<String>>,
    presets: Vec<crate::theme_presets::Preset>,
    packages: Vec<String>,
}

fn invalid(message: &str) -> AppError {
    AppError::InvalidArg(format!("backup resources: {message}"))
}

pub(super) fn token_directory(root: &Path, token: &str) -> AppResult<PathBuf> {
    let id = uuid::Uuid::parse_str(token).map_err(|_| invalid("invalid import token"))?;
    if id.to_string() != token {
        return Err(invalid("invalid import token"));
    }
    let directory = root.join(token);
    reject_links(&directory)?;
    Ok(directory)
}

fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 2048
        && path.split('/').all(|part| {
            let stem = part
                .split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_uppercase();
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.ends_with(['.', ' '])
                && !part.chars().any(|c| {
                    c.is_control() || matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
                })
                && !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                && !(stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        })
}

fn allowed_path(path: &str, directory: bool) -> bool {
    safe_path(path)
        && ((!directory && path == PAYLOAD)
            || path == "portable/plugin-data" && directory
            || path.starts_with("portable/plugin-data/")
            || path.starts_with("portable/packages/")
                && path.split('/').count() >= if directory { 3 } else { 4 })
}

fn reject_links(path: &Path) -> AppResult<()> {
    for parent in path.ancestors() {
        match fs::symlink_metadata(parent) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(invalid("symbolic links are not supported"))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

fn validate_index(index: &Index) -> AppResult<()> {
    if index.files.len() + index.directories.len() > 100_000 {
        return Err(invalid("too many files"));
    }
    let mut paths = BTreeSet::new();
    let mut total = 0u64;
    for entry in &index.files {
        if !allowed_path(&entry.path, false)
            || !paths.insert(entry.path.to_lowercase())
            || entry.sha256.len() != 64
            || !entry.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            || entry.mode & !0o777 != 0
        {
            return Err(invalid("invalid or duplicate file entry"));
        }
        total = total
            .checked_add(entry.size)
            .ok_or_else(|| invalid("size overflow"))?;
    }
    for path in &index.directories {
        if !allowed_path(path, true) || !paths.insert(path.to_lowercase()) {
            return Err(invalid("invalid or duplicate directory entry"));
        }
    }
    if total > MAX_TOTAL
        || !index
            .files
            .iter()
            .any(|entry| entry.path == PAYLOAD && entry.size <= MAX_JSON)
        || !index
            .directories
            .iter()
            .any(|path| path == "portable/plugin-data")
    {
        return Err(invalid("incomplete or oversized resources"));
    }
    let files: BTreeSet<_> = index
        .files
        .iter()
        .map(|entry| entry.path.to_lowercase())
        .collect();
    for path in &paths {
        let mut parent = path.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            if files.contains(prefix) {
                return Err(invalid("file/directory collision"));
            }
            parent = prefix;
        }
    }
    Ok(())
}

fn read_payload(directory: &Path) -> AppResult<Payload> {
    let path = directory.join(PAYLOAD);
    if fs::metadata(&path)?.len() > MAX_JSON {
        return Err(invalid("settings too large"));
    }
    let payload: Payload =
        serde_json::from_slice(&fs::read(path)?).map_err(|e| invalid(&e.to_string()))?;
    if payload.version != 1 || payload.packages.len() > 4096 {
        return Err(invalid("unsupported resource version"));
    }
    crate::ui_settings::validate_backup_values(&payload.vault_settings, false)?;
    crate::ui_settings::validate_backup_values(&payload.device_settings, true)?;
    #[cfg(desktop)]
    crate::desktop_settings::validate_backup_values(&payload.desktop_settings)?;
    // Mobile has no desktop settings document. Carry the values unread.
    #[cfg(not(desktop))]
    if !payload.desktop_settings.is_object() {
        return Err(invalid("invalid desktop backup settings"));
    }
    crate::theme_presets::validate_backup_presets(&payload.presets)?;
    let mut ids = BTreeSet::new();
    for id in &payload.packages {
        if !safe_path(id) || id.contains('/') || !ids.insert(id) {
            return Err(invalid("invalid package ID"));
        }
    }
    for (id, values) in &payload.device_plugin_settings {
        if !safe_path(id)
            || id.contains('/')
            || values.keys().any(|key| key.is_empty() || key.len() > 512)
        {
            return Err(invalid("invalid plugin setting"));
        }
    }
    for (id, keys) in &payload.device_plugin_keys {
        if !safe_path(id)
            || id.contains('/')
            || keys.iter().any(|key| key.is_empty() || key.len() > 512)
        {
            return Err(invalid("invalid device setting scope"));
        }
    }
    Ok(payload)
}

fn add_file(source: &Path, destination: &Path, path: String, index: &mut Index) -> AppResult<()> {
    reject_links(source)?;
    let meta = fs::symlink_metadata(source)?;
    if !meta.is_file() {
        return Err(invalid("only regular files can be backed up"));
    }
    let before = super::restore::restore_file_hash(source)?;
    let target = destination.join(&path);
    fs::create_dir_all(
        target
            .parent()
            .ok_or_else(|| invalid("file parent missing"))?,
    )?;
    let mut output = fs::File::create(&target)?;
    std::io::copy(&mut fs::File::open(source)?, &mut output)?;
    output.sync_all()?;
    drop(output);
    let sha256 = super::restore::restore_file_hash(&target)?;
    if sha256 != before || super::restore::restore_file_hash(source)? != before {
        return Err(invalid("a file changed during export; retry the backup"));
    }
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o777
    };
    #[cfg(not(unix))]
    let mode = 0o644;
    index.files.push(Entry {
        path,
        sha256,
        size: fs::metadata(target)?.len(),
        mode,
    });
    Ok(())
}

fn add_tree(source: &Path, destination: &Path, path: &str, index: &mut Index) -> AppResult<()> {
    reject_links(source)?;
    index.directories.push(path.into());
    fs::create_dir_all(destination.join(path))?;
    if !source.try_exists()? {
        return Ok(());
    }
    if !fs::symlink_metadata(source)?.is_dir() {
        return Err(invalid("expected a directory"));
    }
    for item in fs::read_dir(source)? {
        let item = item?;
        let name = item
            .file_name()
            .into_string()
            .map_err(|_| invalid("filename is not UTF-8"))?;
        let child = format!("{path}/{name}");
        if !safe_path(&child) {
            return Err(invalid("filename is not portable"));
        }
        let kind = item.file_type()?;
        if kind.is_dir() {
            add_tree(&item.path(), destination, &child, index)?;
        } else if kind.is_file() {
            add_file(&item.path(), destination, child, index)?;
        } else {
            return Err(invalid("links and special files cannot be backed up"));
        }
    }
    Ok(())
}

pub(super) fn capture(
    root: &Path,
    vault: &Path,
    conn: &Connection,
    directory: &Path,
) -> AppResult<Index> {
    let mut plugins = crate::plugins::discovery::discover_builtins();
    plugins.extend(crate::plugins::packages::discover(
        &root.join("plugins"),
        None,
    )?);
    let mut device_plugin_keys = BTreeMap::new();
    for plugin in &plugins {
        crate::plugins::settings::effective(root, vault, conn, plugin)?;
        device_plugin_keys.insert(
            plugin.id.clone(),
            crate::plugins::settings::scoped_device_keys(plugin),
        );
    }
    let payload = {
        let _lock = RootLock::acquire(root)?;
        let device_plugin_settings = crate::plugins::settings::backup_values(root)?;
        for (id, settings) in &device_plugin_settings {
            device_plugin_keys
                .entry(id.clone())
                .or_default()
                .extend(settings.keys().cloned());
        }
        Payload {
            version: 1,
            vault_settings: crate::ui_settings::backup_values(vault, false)?,
            device_settings: crate::ui_settings::backup_values(root, true)?,
            #[cfg(desktop)]
            desktop_settings: crate::desktop_settings::backup_values(root)?,
            #[cfg(not(desktop))]
            desktop_settings: serde_json::json!({}),
            device_plugin_settings,
            device_plugin_keys,
            presets: crate::theme_presets::backup_presets(root)?,
            packages: plugins
                .iter()
                .filter(|p| p.source == crate::plugins::SOURCE_INSTALLED)
                .map(|p| p.id.clone())
                .collect(),
        }
    };
    fs::create_dir_all(directory)?;
    crate::atomic_file::write(
        &directory.join(PAYLOAD),
        &serde_json::to_vec(&payload).map_err(|e| invalid(&e.to_string()))?,
    )?;
    let mut index = Index {
        files: vec![Entry {
            path: PAYLOAD.into(),
            sha256: super::restore::restore_file_hash(&directory.join(PAYLOAD))?,
            size: fs::metadata(directory.join(PAYLOAD))?.len(),
            mode: 0o600,
        }],
        directories: Vec::new(),
    };
    add_tree(
        &vault.join("plugin-data"),
        directory,
        "portable/plugin-data",
        &mut index,
    )?;
    for plugin in plugins {
        if plugin.source != crate::plugins::SOURCE_INSTALLED {
            continue;
        }
        let crate::plugins::discovery::PluginFiles::Fs(source) = plugin.files else {
            return Err(invalid("installed package is not on disk"));
        };
        add_tree(
            &source,
            directory,
            &format!("portable/packages/{}", plugin.id),
            &mut index,
        )?;
    }
    validate_bundle(directory, &index)?;
    Ok(index)
}

pub(super) fn validate_bundle(directory: &Path, index: &Index) -> AppResult<()> {
    validate_index(index)?;
    for entry in &index.files {
        let path = directory.join(&entry.path);
        reject_links(&path)?;
        let meta = fs::symlink_metadata(&path)?;
        if !meta.is_file()
            || meta.len() != entry.size
            || super::restore::restore_file_hash(&path)? != entry.sha256
        {
            return Err(invalid("file checksum mismatch"));
        }
    }
    for path in &index.directories {
        reject_links(&directory.join(path))?;
    }
    let payload = read_payload(directory)?;
    let builtin_ids: BTreeSet<_> = crate::plugins::discovery::discover_builtins()
        .into_iter()
        .map(|plugin| plugin.id)
        .collect();
    for id in &payload.packages {
        if builtin_ids.contains(id) {
            return Err(invalid("backup cannot replace a builtin plugin"));
        }
        let path = directory.join("portable/packages").join(id);
        let plugin = crate::plugins::discovery::read_plugin(
            crate::plugins::discovery::PluginFiles::Fs(path),
            crate::plugins::SOURCE_INSTALLED,
        )?;
        if plugin.id != *id {
            return Err(invalid("package ID mismatch"));
        }
    }
    for entry in &index.files {
        if entry.path.starts_with("portable/packages/")
            && !payload
                .packages
                .iter()
                .any(|id| entry.path.starts_with(&format!("portable/packages/{id}/")))
        {
            return Err(invalid("unlisted package"));
        }
    }
    Ok(())
}

pub(super) fn extract<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    directory: &Path,
    index: &Index,
) -> AppResult<()> {
    validate_index(index)?;
    for path in &index.directories {
        fs::create_dir_all(directory.join(path))?;
    }
    for entry in &index.files {
        let mut input = archive.by_name(&entry.path).map_err(zip_to_app)?;
        if input.size() != entry.size
            || input
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(invalid("invalid archive file"));
        }
        let target = directory.join(&entry.path);
        fs::create_dir_all(
            target
                .parent()
                .ok_or_else(|| invalid("file parent missing"))?,
        )?;
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)?;
        let copied = std::io::copy(&mut input.by_ref().take(entry.size + 1), &mut out)?;
        if copied != entry.size {
            return Err(invalid("archive size mismatch"));
        }
        out.sync_all()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&target, fs::Permissions::from_mode(entry.mode))?;
        }
    }
    validate_bundle(directory, index)
}

pub(super) fn stage(directory: &Path, vault: &Path, index: &Index) -> AppResult<String> {
    validate_bundle(directory, index)?;
    let pending = vault.join(PENDING);
    reject_links(&pending)?;
    if pending.try_exists()? {
        return Err(invalid("an unfinished resource restore already exists"));
    }
    crate::atomic_file::write(
        &directory.join(INDEX),
        &serde_json::to_vec(&PendingIndex {
            id: uuid::Uuid::new_v4(),
            index: index.clone(),
        })
        .map_err(|e| invalid(&e.to_string()))?,
    )?;
    let hash = super::restore::restore_file_hash(&directory.join(INDEX))?;
    fs::rename(directory, &pending)?;
    crate::atomic_file::sync_directory(vault)?;
    Ok(hash)
}

pub(super) fn pending_index(vault: &Path, hash: &str) -> AppResult<Index> {
    let pending = vault.join(PENDING);
    reject_links(&pending.join(INDEX))?;
    if fs::metadata(pending.join(INDEX))?.len() > 32 * MAX_JSON
        || super::restore::restore_file_hash(&pending.join(INDEX))? != hash
    {
        return Err(invalid("pending resource index changed"));
    }
    let PendingIndex { index, .. } = serde_json::from_slice(&fs::read(pending.join(INDEX))?)
        .map_err(|e| invalid(&e.to_string()))?;
    validate_bundle(&pending, &index)?;
    Ok(index)
}

/// Remove device-owned legacy rows and portable third-party execution authority.
pub(super) fn sanitize_database(database: &Path, directory: Option<&Path>) -> AppResult<()> {
    let mut conn = Connection::open(database)?;
    let tx = conn.transaction()?;
    let builtins: BTreeSet<_> = crate::plugins::discovery::discover_builtins()
        .into_iter()
        .map(|plugin| plugin.id)
        .collect();
    let ids = tx
        .prepare("SELECT id FROM plugins")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    tx.execute("UPDATE plugins SET source_path = NULL", [])?;
    for id in ids {
        if !builtins.contains(&id) {
            tx.execute(
                "UPDATE plugins SET enabled = 0, accepted_hash = '', signer = NULL WHERE id = ?1",
                [&id],
            )?;
            tx.execute(
                "DELETE FROM plugin_installations WHERE plugin_id = ?1",
                [&id],
            )?;
        }
    }
    if let Some(directory) = directory {
        let payload = read_payload(directory)?;
        for (id, keys) in payload.device_plugin_keys {
            for key in keys {
                tx.execute(
                    "DELETE FROM plugin_settings WHERE plugin_id = ?1 AND key = ?2",
                    params![id, key],
                )?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}

fn tree_matches(directory: &Path, prefix: &str, index: &Index) -> AppResult<bool> {
    if !directory.is_dir() {
        return Ok(false);
    }
    let expected: BTreeMap<_, _> = index
        .files
        .iter()
        .filter_map(|entry| {
            entry
                .path
                .strip_prefix(&format!("{prefix}/"))
                .map(|path| (path.to_owned(), entry))
        })
        .collect();
    fn list(
        directory: &Path,
        relative: &str,
        paths: &mut BTreeSet<String>,
        directories: &mut BTreeSet<String>,
    ) -> AppResult<()> {
        for item in fs::read_dir(directory)? {
            let item = item?;
            let name = item
                .file_name()
                .into_string()
                .map_err(|_| invalid("filename is not UTF-8"))?;
            let path = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            if item.file_type()?.is_dir() {
                directories.insert(path.clone());
                list(&item.path(), &path, paths, directories)?;
            } else if item.file_type()?.is_file() {
                paths.insert(path);
            } else {
                return Err(invalid("invalid restored tree"));
            }
        }
        Ok(())
    }
    reject_links(directory)?;
    let mut actual = BTreeSet::new();
    let mut directories = BTreeSet::new();
    list(directory, "", &mut actual, &mut directories)?;
    let expected_directories = index
        .directories
        .iter()
        .filter_map(|path| path.strip_prefix(&format!("{prefix}/")).map(str::to_owned))
        .collect();
    if directories != expected_directories {
        return Ok(false);
    }
    if actual != expected.keys().cloned().collect() {
        return Ok(false);
    }
    for (path, entry) in expected {
        if super::restore::restore_file_hash(&directory.join(path))? != entry.sha256 {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) fn apply(root: &Path, vault: &Path, hash: &str, include_device: bool) -> AppResult<()> {
    let index = pending_index(vault, hash)?;
    let pending = vault.join(PENDING);
    let payload = read_payload(&pending)?;
    let safety = vault
        .join("backups")
        .join(format!("pre-restore-files-{hash}"));
    reject_links(&safety)?;
    fs::create_dir_all(&safety)?;
    let data = vault.join("plugin-data");
    reject_links(&data)?;
    if !tree_matches(&data, "portable/plugin-data", &index)? {
        let old = safety.join("plugin-data");
        if data.try_exists()? {
            if old.try_exists()? {
                return Err(invalid(
                    "ambiguous plugin-data restore; safety files retained",
                ));
            }
            fs::rename(&data, &old)?;
            crate::atomic_file::sync_directory(vault)?;
            crate::atomic_file::sync_directory(&safety)?;
        }
        let temporary = vault.join(format!(".restore-data-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&temporary)?;
        for path in &index.directories {
            if let Some(relative) = path.strip_prefix("portable/plugin-data/") {
                fs::create_dir_all(temporary.join(relative))?;
            }
        }
        for entry in &index.files {
            if let Some(relative) = entry.path.strip_prefix("portable/plugin-data/") {
                let target = temporary.join(relative);
                fs::create_dir_all(
                    target
                        .parent()
                        .ok_or_else(|| invalid("file parent missing"))?,
                )?;
                let mut output = fs::File::create(&target)?;
                std::io::copy(&mut fs::File::open(pending.join(&entry.path))?, &mut output)?;
                output.sync_all()?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&target, fs::Permissions::from_mode(entry.mode))?;
                }
            }
        }
        crate::atomic_file::sync_directory(&temporary)?;
        fs::rename(temporary, &data)?;
        crate::atomic_file::sync_directory(vault)?;
    }
    {
        let _lock = RootLock::acquire(root)?;
        let settings = vault.join("content-settings.json");
        reject_links(&settings)?;
        if settings.try_exists()? && !safety.join("content-settings.json").try_exists()? {
            crate::atomic_file::write(
                &safety.join("content-settings.json"),
                &fs::read(&settings)?,
            )?;
        }
        crate::ui_settings::restore_backup_values(vault, &payload.vault_settings, false)?;
        if include_device {
            crate::theme_presets::restore_backup_presets(root, &payload.presets)?;
            crate::ui_settings::restore_backup_values(root, &payload.device_settings, true)?;
            #[cfg(desktop)]
            crate::desktop_settings::restore_backup_values(root, &payload.desktop_settings)?;
            crate::plugins::settings::restore_backup_values(root, &payload.device_plugin_settings)?;
        }
    }
    if include_device {
        for id in &payload.packages {
            crate::plugins::packages::restore_missing(
                root,
                &pending.join("portable/packages").join(id),
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn index() -> Index {
        Index {
            files: vec![Entry {
                path: PAYLOAD.into(),
                sha256: "0".repeat(64),
                size: 1,
                mode: 0o600,
            }],
            directories: vec!["portable/plugin-data".into()],
        }
    }
    #[test]
    fn archive_paths_reject_traversal_windows_devices_aliases_and_type_collisions() {
        for path in [
            "portable/plugin-data/../escape",
            "portable/plugin-data/a\\b",
            "portable/plugin-data/a:b",
            "portable/plugin-data/CON.txt",
            "portable/plugin-data/a.",
            "portable/plugin-data/LPT1",
            "/portable/plugin-data/x",
        ] {
            let mut bad = index();
            bad.files.push(Entry {
                path: path.into(),
                sha256: "0".repeat(64),
                size: 1,
                mode: 0o600,
            });
            assert!(validate_index(&bad).is_err(), "{path}");
        }
        let mut bad = index();
        bad.files.push(Entry {
            path: "Portable.JSON".into(),
            sha256: "0".repeat(64),
            size: 1,
            mode: 0o600,
        });
        assert!(validate_index(&bad).is_err());
        let mut bad = index();
        bad.files.push(Entry {
            path: "portable/plugin-data/file".into(),
            sha256: "0".repeat(64),
            size: 1,
            mode: 0o600,
        });
        bad.directories
            .push("portable/plugin-data/file/child".into());
        assert!(validate_index(&bad).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn filesystem_capture_rejects_symlinks_instead_of_following_them() {
        let root = std::env::temp_dir().join(format!("ms-backup-link-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("data")).unwrap();
        fs::write(root.join("secret"), b"private").unwrap();
        std::os::unix::fs::symlink(root.join("secret"), root.join("data/link")).unwrap();
        assert!(add_tree(
            &root.join("data"),
            &root.join("output"),
            "portable/plugin-data",
            &mut index()
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
