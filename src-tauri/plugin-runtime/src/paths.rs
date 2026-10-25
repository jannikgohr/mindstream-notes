//! Keeping plugin-supplied paths inside the directory the host chose.
//!
//! Every path a plugin names, whether through the storage commands or from
//! inside a script, goes through [`split_rel_path`] and then one of the
//! containment checks below. The data root itself is picked by the host from
//! the plugin id. A plugin never names it.

use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::error::{HostError, HostResult};

/// One path segment the host is willing to create: ASCII letters, digits and
/// `._-`, and not `.` or `..`.
pub fn safe_segment(value: &str, label: &str) -> HostResult<()> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(HostError::Invalid(format!("unsafe {label} '{value}'")));
    }
    Ok(())
}

/// Split a plugin-relative path into checked segments.
///
/// Refuses absolute paths, backslashes, `..` and any segment
/// [`safe_segment`] refuses. An empty path is the root when `allow_empty` is
/// set and an error otherwise.
pub fn split_rel_path(path: &str, allow_empty: bool) -> HostResult<Vec<String>> {
    if path.starts_with('/') || path.starts_with('\\') || path.contains('\\') {
        return Err(HostError::Invalid(format!(
            "unsafe plugin storage path '{path}'"
        )));
    }
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        if allow_empty {
            return Ok(Vec::new());
        }
        return Err(HostError::Invalid("plugin storage path is empty".into()));
    }
    let mut out = Vec::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_string_lossy();
                safe_segment(&part, "plugin storage path segment")?;
                out.push(part.into_owned());
            }
            _ => {
                return Err(HostError::Invalid(format!(
                    "unsafe plugin storage path '{path}'"
                )));
            }
        }
    }
    Ok(out)
}

/// `root` joined with the checked segments of `rel`. Creates nothing.
pub fn join_rel(root: &Path, rel: &str, allow_empty: bool) -> HostResult<PathBuf> {
    let mut out = root.to_path_buf();
    for segment in split_rel_path(rel, allow_empty)? {
        out.push(segment);
    }
    Ok(out)
}

/// Fail unless `target`, with symlinks resolved, is inside `root`.
///
/// `target` has to exist: canonicalizing is what catches a symlink pointing
/// out of the root.
pub fn ensure_inside_root(root: &Path, target: &Path) -> HostResult<()> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let target = target
        .canonicalize()
        .map_err(|e| HostError::Invalid(format!("plugin storage path: {e}")))?;
    if !target.starts_with(root) {
        return Err(HostError::Invalid(
            "plugin storage path escapes plugin data directory".into(),
        ));
    }
    Ok(())
}

/// Refuse a write whose target is a symlink, and containment-check the parent
/// when the file does not exist yet. Checking only the parent is not enough:
/// `fs::write` would follow a symlink at the target path.
pub fn ensure_write_target_safe(root: &Path, target: &Path) -> HostResult<()> {
    match fs::symlink_metadata(target) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(HostError::Invalid(
                    "plugin storage path targets a symlink".into(),
                ));
            }
            ensure_inside_root(root, target)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let parent = target
                .parent()
                .ok_or_else(|| HostError::Invalid("plugin storage path has no parent".into()))?;
            ensure_inside_root(root, parent)
        }
        Err(err) => Err(err.into()),
    }
}

/// Create `dir` and its missing parents, but only after checking that the
/// deepest part of it that already exists is inside `root`.
///
/// `create_dir_all` alone would follow a symlinked directory partway down the
/// path and create the rest of it wherever that points, before any check
/// after it could refuse.
pub fn create_dir_inside(root: &Path, dir: &Path) -> HostResult<()> {
    fs::create_dir_all(root)?;
    let mut existing = dir;
    while fs::symlink_metadata(existing).is_err() {
        existing = existing
            .parent()
            .ok_or_else(|| HostError::Invalid("plugin storage path has no parent".into()))?;
    }
    ensure_inside_root(root, existing)?;
    fs::create_dir_all(dir)?;
    ensure_inside_root(root, dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ms-paths-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn safe_segments_are_plain_names() {
        assert!(safe_segment("cache", "seg").is_ok());
        assert!(safe_segment("file.name-1_2", "seg").is_ok());
        for bad in ["", ".", "..", "a/b", "a b", "ü"] {
            assert!(safe_segment(bad, "seg").is_err(), "{bad:?}");
        }
    }

    #[test]
    fn relative_paths_split_and_refuse_escapes() {
        assert_eq!(
            split_rel_path("cache/compiler.json", false).unwrap(),
            ["cache", "compiler.json"]
        );
        assert_eq!(split_rel_path("", true).unwrap(), Vec::<String>::new());
        assert_eq!(split_rel_path("a//b/", false).unwrap(), ["a", "b"]);
        assert_eq!(split_rel_path("a/", true).unwrap(), ["a"]);
        assert!(split_rel_path("/a", true).is_err());
        assert!(split_rel_path("a\\b", true).is_err());
        for bad in ["../escape", "cache/../escape", "/absolute", "a\\b", ""] {
            assert!(split_rel_path(bad, false).is_err(), "{bad:?}");
        }
        let err = split_rel_path("../x", false).unwrap_err();
        assert!(
            err.to_string().contains("unsafe plugin storage path"),
            "{err}"
        );
    }

    #[test]
    fn join_rel_builds_under_the_root() {
        let root = Path::new("/data/plugin");
        assert_eq!(
            join_rel(root, "a/b.txt", false).unwrap(),
            root.join("a").join("b.txt")
        );
        assert_eq!(join_rel(root, "", true).unwrap(), root);
        assert!(join_rel(root, "", false).is_err());
    }

    #[test]
    fn containment_resolves_symlinks_and_missing_targets() {
        let root = scratch();
        let inside = root.join("inside.txt");
        fs::write(&inside, "x").unwrap();
        assert!(ensure_inside_root(&root, &inside).is_ok());
        assert!(ensure_inside_root(&root, &root.join("missing")).is_err());
        let outside = scratch();
        assert!(ensure_inside_root(&root, &outside).is_err());
        fs::remove_dir_all(root).ok();
        fs::remove_dir_all(outside).ok();
    }

    #[test]
    fn write_targets_may_be_new_or_existing_files_inside() {
        let root = scratch();
        assert!(ensure_write_target_safe(&root, &root.join("new.txt")).is_ok());
        fs::write(root.join("old.txt"), "x").unwrap();
        assert!(ensure_write_target_safe(&root, &root.join("old.txt")).is_ok());
        assert!(ensure_write_target_safe(&root, &root.join("no/parent.txt")).is_err());
        fs::remove_dir_all(root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_lead_out_of_the_root() {
        let root = scratch();
        let outside = scratch();
        std::os::unix::fs::symlink(outside.join("victim"), root.join("file")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("dir")).unwrap();

        let err = ensure_write_target_safe(&root, &root.join("file")).unwrap_err();
        assert!(err.to_string().contains("symlink"), "{err}");
        assert!(create_dir_inside(&root, &root.join("dir").join("sub")).is_err());
        assert!(
            !outside.join("sub").exists(),
            "nothing was created through the link"
        );
        fs::remove_dir_all(root).ok();
        fs::remove_dir_all(outside).ok();
    }

    #[test]
    fn directories_are_created_inside_the_root() {
        let root = scratch();
        let dir = root.join("a").join("b");
        create_dir_inside(&root, &dir).unwrap();
        assert!(dir.is_dir());
        fs::remove_dir_all(root).ok();
    }
}
