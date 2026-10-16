//! Shared dictionary publication. A manifest selects one immutable file pair.
//! A crashed unpublished generation is ignored. Tombstones prevent legacy
//! flat files from resurrecting a removed dictionary after interrupted cleanup.
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::storage_locks::RootLock;

const SUFFIX: &str = ".dictionary.json";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    generation: Option<uuid::Uuid>,
}

pub(super) fn validate_id(id: &str) -> AppResult<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(AppError::InvalidArg("invalid dictionary ID".into()));
    }
    Ok(())
}

fn manifest_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}{SUFFIX}"))
}

fn resolve_locked(dir: &Path, id: &str) -> AppResult<Option<(PathBuf, PathBuf)>> {
    validate_id(id)?;
    match fs::read(manifest_path(dir, id)) {
        Ok(raw) => {
            let manifest: Manifest = serde_json::from_slice(&raw)
                .map_err(|err| AppError::InvalidArg(format!("dictionary {id} manifest: {err}")))?;
            if manifest.version != 1 {
                return Err(AppError::InvalidArg(format!(
                    "unsupported dictionary {id} manifest version"
                )));
            }
            let paths = manifest.generation.map(|generation| {
                let pair = dir.join(".pairs").join(id).join(generation.to_string());
                (pair.join("dictionary.aff"), pair.join("dictionary.dic"))
            });
            if let Some((aff, dic)) = &paths {
                if !aff.try_exists()? || !dic.try_exists()? {
                    return Err(AppError::InvalidArg(format!(
                        "dictionary {id} references a missing file pair; recovery required"
                    )));
                }
            }
            Ok(paths)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let aff = dir.join(format!("{id}.aff"));
            let dic = dir.join(format!("{id}.dic"));
            Ok((aff.try_exists()? && dic.try_exists()?).then_some((aff, dic)))
        }
        Err(err) => Err(err.into()),
    }
}

pub(super) fn resolve(dir: &Path, id: &str) -> AppResult<Option<(PathBuf, PathBuf)>> {
    let _lock = RootLock::acquire(dir)?;
    resolve_locked(dir, id)
}

pub(super) fn load(dir: &Path, id: &str) -> AppResult<spellbook::Dictionary> {
    let _lock = RootLock::acquire(dir)?;
    let (aff, dic) =
        resolve_locked(dir, id)?.ok_or_else(|| AppError::NotFound(format!("dictionary {id}")))?;
    super::dictionary::load_dictionary(&aff, &dic)
}

pub(super) fn word_chars(dir: &Path, id: &str) -> AppResult<String> {
    let _lock = RootLock::acquire(dir)?;
    let (aff, _) =
        resolve_locked(dir, id)?.ok_or_else(|| AppError::NotFound(format!("dictionary {id}")))?;
    super::dictionary::read_word_chars(&aff)
}

/// Network and validation happen before taking the shared publication lock.
pub(super) fn publish(dir: &Path, id: &str, aff: &[u8], dic: &[u8]) -> AppResult<()> {
    validate_id(id)?;
    let generation = uuid::Uuid::new_v4();
    let pair = dir.join(".pairs").join(id).join(generation.to_string());
    crate::atomic_file::write(&pair.join("dictionary.aff"), aff)?;
    crate::atomic_file::write(&pair.join("dictionary.dic"), dic)?;
    super::dictionary::load_dictionary(&pair.join("dictionary.aff"), &pair.join("dictionary.dic"))?;
    // Flush generation ancestor entries before publishing the manifest.
    // Windows reboot durability still needs platform verification.
    crate::atomic_file::sync_directory(&dir.join(".pairs").join(id))?;
    crate::atomic_file::sync_directory(&dir.join(".pairs"))?;
    crate::atomic_file::sync_directory(dir)?;
    let _lock = RootLock::acquire(dir)?;
    // Reject corrupt existing manifests rather than overwriting recovery state.
    resolve_locked(dir, id)?;
    write_manifest(dir, id, Some(generation))
}

fn write_manifest(dir: &Path, id: &str, generation: Option<uuid::Uuid>) -> AppResult<()> {
    let raw = serde_json::to_vec(&Manifest {
        version: 1,
        generation,
    })
    .map_err(|err| AppError::InvalidArg(err.to_string()))?;
    crate::atomic_file::write(&manifest_path(dir, id), &raw)?;
    Ok(())
}

pub(super) fn remove(dir: &Path, id: &str) -> AppResult<()> {
    validate_id(id)?;
    let _lock = RootLock::acquire(dir)?;
    resolve_locked(dir, id)?;
    write_manifest(dir, id, None)?;
    for extension in ["aff", "dic"] {
        match fs::remove_file(dir.join(format!("{id}.{extension}"))) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
    }
    crate::atomic_file::sync_directory(dir)?;
    // Keep immutable generations: another worker may still be loading one.
    // Bounded garbage collection needs worker ownership and is a later step.
    Ok(())
}

pub(super) fn installed(dir: &Path) -> AppResult<Vec<super::InstalledDictionary>> {
    let _lock = RootLock::acquire(dir)?;
    let mut ids = std::collections::BTreeSet::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if let Some(id) = name
            .strip_suffix(SUFFIX)
            .or_else(|| name.strip_suffix(".aff"))
        {
            validate_id(id)?;
            ids.insert(id.to_owned());
        }
    }
    let mut installed = Vec::new();
    for id in ids {
        if let Some((aff, dic)) = resolve_locked(dir, &id)? {
            installed.push(super::InstalledDictionary {
                id,
                bytes: fs::metadata(aff)?.len() + fs::metadata(dic)?.len(),
            });
        }
    }
    Ok(installed)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("ms-dict-pairs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn unpublished_or_invalid_pairs_leave_the_previous_dictionary_readable() {
        let root = root();
        fs::write(root.join("en_US.aff"), b"SET UTF-8\n").unwrap();
        fs::write(root.join("en_US.dic"), b"1\nlegacy\n").unwrap();
        let interrupted = root
            .join(".pairs/en_US")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&interrupted).unwrap();
        fs::write(interrupted.join("dictionary.aff"), b"partial").unwrap();
        assert!(load(&root, "en_US").unwrap().check("legacy"));
        assert!(publish(&root, "en_US", b"SET unsupported\n", b"1\nnew\n").is_err());
        assert!(load(&root, "en_US").unwrap().check("legacy"));
        publish(&root, "en_US", b"SET UTF-8\n", b"1\nnew\n").unwrap();
        assert!(load(&root, "en_US").unwrap().check("new"));
        assert_eq!(installed(&root).unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tombstones_override_legacy_files_even_after_interrupted_removal() {
        let root = root();
        publish(&root, "en_US", b"SET UTF-8\n", b"1\nnew\n").unwrap();
        remove(&root, "en_US").unwrap();
        // Simulate a crash after tombstone publication but before flat cleanup.
        fs::write(root.join("en_US.aff"), b"SET UTF-8\n").unwrap();
        fs::write(root.join("en_US.dic"), b"1\nlegacy\n").unwrap();
        assert!(resolve(&root, "en_US").unwrap().is_none());
        assert!(installed(&root).unwrap().is_empty());
        remove(&root, "en_US").unwrap();
        assert!(!root.join("en_US.aff").exists());
        publish(&root, "en_US", b"SET UTF-8\n", b"1\nreinstalled\n").unwrap();
        assert!(load(&root, "en_US").unwrap().check("reinstalled"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_manifests_and_unsafe_ids_are_preserved_and_refused() {
        let root = root();
        let path = manifest_path(&root, "en_US");
        fs::write(&path, b"broken").unwrap();
        assert!(load(&root, "en_US").is_err());
        assert!(remove(&root, "en_US").is_err());
        assert!(publish(&root, "en_US", b"SET UTF-8\n", b"1\nnew\n").is_err());
        assert_eq!(fs::read(path).unwrap(), b"broken");
        for id in ["../outside", "", "a/b", "a\\b"] {
            assert!(remove(&root, id).is_err());
            assert!(publish(&root, id, b"", b"").is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_referenced_pairs_do_not_fall_back_to_legacy_or_get_overwritten() {
        let root = root();
        let raw = serde_json::to_vec(&Manifest {
            version: 1,
            generation: Some(uuid::Uuid::new_v4()),
        })
        .unwrap();
        let path = manifest_path(&root, "en_US");
        fs::write(&path, &raw).unwrap();
        fs::write(root.join("en_US.aff"), b"SET UTF-8\n").unwrap();
        fs::write(root.join("en_US.dic"), b"1\nlegacy\n").unwrap();
        assert!(load(&root, "en_US").is_err());
        assert!(installed(&root).is_err());
        assert!(publish(&root, "en_US", b"SET UTF-8\n", b"1\nnew\n").is_err());
        assert_eq!(fs::read(path).unwrap(), raw);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_publication_and_readers_observe_complete_matching_pairs() {
        let root = root();
        let first_aff = b"SET UTF-8\nWORDCHARS x\n";
        let second_aff = b"SET UTF-8\nWORDCHARS y\n";
        publish(&root, "en_US", first_aff, b"1\nalpha\n").unwrap();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                for _ in 0..20 {
                    publish(&root, "en_US", second_aff, b"1\nbeta\n").unwrap();
                    publish(&root, "en_US", first_aff, b"1\nalpha\n").unwrap();
                }
            });
            scope.spawn(|| {
                for _ in 0..50 {
                    let (aff, dic) = resolve(&root, "en_US").unwrap().unwrap();
                    let aff = fs::read(aff).unwrap();
                    let dic = fs::read(dic).unwrap();
                    assert!(
                        (aff == first_aff && dic == b"1\nalpha\n")
                            || (aff == second_aff && dic == b"1\nbeta\n")
                    );
                    assert!(load(&root, "en_US").is_ok());
                }
            });
        });
        fs::remove_dir_all(root).unwrap();
    }
}
