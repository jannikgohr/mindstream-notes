//! Validated recovery copies for root JSON documents. Callers hold RootLock.
//! Recovery preserves corrupt bytes before promoting a validated previous copy.
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

fn previous_path(path: &Path) -> AppResult<PathBuf> {
    let name = path
        .file_name()
        .ok_or_else(|| AppError::InvalidArg("document filename missing".into()))?;
    let mut name = name.to_os_string();
    name.push(".previous");
    Ok(path.with_file_name(name))
}

fn read_optional(path: &Path) -> AppResult<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

/// Preserve the valid current document before replacing it. Invalid current
/// state cannot be overwritten by an ordinary save, even with valid new bytes.
pub fn write(path: &Path, raw: &[u8], validate: impl Fn(&[u8]) -> AppResult<()>) -> AppResult<()> {
    validate(raw)?;
    if let Some(current) = read_optional(path)? {
        validate(&current)?;
        crate::atomic_file::write(&previous_path(path)?, &current)?;
    } else if previous_path(path)?.try_exists()? {
        return Err(AppError::InvalidArg(
            "root document missing; startup recovery required".into(),
        ));
    }
    crate::atomic_file::write(path, raw)?;
    Ok(())
}

/// The recovery validator may be stricter than the normal schema validator,
/// for example refusing an old index that references a deleted vault.
pub fn recover(
    path: &Path,
    validate_current: impl Fn(&[u8]) -> AppResult<()>,
    validate_previous: impl Fn(&[u8]) -> AppResult<()>,
) -> AppResult<()> {
    let current = read_optional(path)?;
    let current_error = match &current {
        Some(raw) => match validate_current(raw) {
            Ok(()) => return Ok(()),
            Err(err) => Some(err),
        },
        None => None,
    };
    let Some(previous) = read_optional(&previous_path(path)?)? else {
        return match current_error {
            Some(err) => Err(err),
            None => Ok(()),
        };
    };
    validate_previous(&previous)?;
    if let Some(current) = current {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        let quarantine = path.with_file_name(format!("{name}.corrupt-{}", uuid::Uuid::new_v4()));
        crate::atomic_file::write(&quarantine, &current)?;
    }
    crate::atomic_file::write(path, &previous)?;
    log::warn!(
        "[recovery] restored validated previous document: {}",
        path.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn validate(raw: &[u8]) -> AppResult<()> {
        serde_json::from_slice::<serde_json::Value>(raw)
            .map(|_| ())
            .map_err(|err| AppError::InvalidArg(err.to_string()))
    }
    fn root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("ms-root-doc-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn corrupt_document_is_quarantined_before_previous_copy_is_promoted() {
        let root = root();
        let path = root.join("document.json");
        write(&path, b"{\"value\":1}", validate).unwrap();
        write(&path, b"{\"value\":2}", validate).unwrap();
        fs::write(&path, b"broken original").unwrap();
        assert!(write(&path, b"{}", validate).is_err());
        recover(&path, validate, validate).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{\"value\":1}");
        let quarantine = fs::read_dir(&root)
            .unwrap()
            .find_map(|entry| {
                let path = entry.unwrap().path();
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains(".corrupt-")
                    .then_some(path)
            })
            .unwrap();
        assert_eq!(fs::read(quarantine).unwrap(), b"broken original");
        recover(&path, validate, validate).unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 3);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_previous_copy_does_not_replace_or_reseed_missing_current() {
        let root = root();
        let path = root.join("document.json");
        fs::write(previous_path(&path).unwrap(), b"broken backup").unwrap();
        assert!(recover(&path, validate, validate).is_err());
        assert!(!path.exists());
        assert!(write(&path, b"{}", validate).is_err());
        fs::write(&path, b"broken current").unwrap();
        assert!(recover(&path, validate, validate).is_err());
        assert_eq!(fs::read(path).unwrap(), b"broken current");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn valid_current_wins_and_missing_current_recovers_without_quarantine() {
        let root = root();
        let path = root.join("document.json");
        write(&path, b"{\"value\":1}", validate).unwrap();
        write(&path, b"{\"value\":2}", validate).unwrap();
        recover(&path, validate, validate).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{\"value\":2}");
        fs::remove_file(&path).unwrap();
        recover(&path, validate, validate).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{\"value\":1}");
        fs::remove_dir_all(root).unwrap();
    }
}
