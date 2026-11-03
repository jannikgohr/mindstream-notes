//! Import sources on disk.

use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use mindstream_storage_core::import::{ImportEntry, ImportFiles};
use walkdir::WalkDir;

use super::stage::StagedArchive;

pub struct DiskFiles {
    root: PathBuf,
    /// Kept alive for the whole run when the source was a `.jex`: the
    /// extracted files are read lazily in phase 2, so dropping this earlier
    /// would delete the vault mid-import.
    _staged: Option<StagedArchive>,
}

impl DiskFiles {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            _staged: None,
        }
    }

    /// Read a `.jex` that was unpacked for this run.
    pub fn staged(staged: StagedArchive) -> Self {
        Self {
            root: staged.path().to_path_buf(),
            _staged: Some(staged),
        }
    }

    fn absolute(&self, relative: &str) -> PathBuf {
        let mut path = self.root.clone();
        for segment in relative.split('/').filter(|s| !s.is_empty()) {
            path.push(segment);
        }
        path
    }
}

/// Path relative to `root`, with forward slashes on every platform so index
/// keys and link targets are directly comparable.
fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    Some(
        relative
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

impl ImportFiles for DiskFiles {
    fn walk(&self, skip_dir: &dyn Fn(&str) -> bool) -> Vec<ImportEntry> {
        let walker = WalkDir::new(&self.root)
            .follow_links(false)
            .sort_by_file_name()
            .into_iter()
            .filter_entry(|entry| !skip_dir(entry.file_name().to_string_lossy().as_ref()));

        let mut entries = Vec::new();
        for entry in walker {
            let entry = match entry {
                Ok(entry) => entry,
                // A single unreadable path shouldn't abort a vault-sized walk.
                Err(err) => {
                    log::warn!("[import] skipping unreadable path: {err}");
                    continue;
                }
            };
            let path = relative_path(&self.root, entry.path()).unwrap_or_default();
            let file_type = entry.file_type();
            if path.is_empty() || !(file_type.is_dir() || file_type.is_file()) {
                continue;
            }
            entries.push(ImportEntry {
                path,
                is_dir: file_type.is_dir(),
            });
        }
        entries
    }

    fn root_files(&self) -> io::Result<Vec<String>> {
        Ok(fs::read_dir(&self.root)?
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_file())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect())
    }

    fn read(&self, path: &str) -> io::Result<Vec<u8>> {
        fs::read(self.absolute(path))
    }

    fn read_range(&self, path: &str, start: u64, length: usize) -> io::Result<Vec<u8>> {
        let mut file = fs::File::open(self.absolute(path))?;
        file.seek(SeekFrom::Start(start))?;
        let mut buffer = Vec::with_capacity(length);
        file.take(length as u64).read_to_end(&mut buffer)?;
        Ok(buffer)
    }

    fn stream(&self, path: &str) -> io::Result<Box<dyn Read>> {
        Ok(Box::new(fs::File::open(self.absolute(path))?))
    }

    fn is_file(&self, path: &str) -> bool {
        self.absolute(path).is_file()
    }

    fn is_dir(&self, path: &str) -> bool {
        self.absolute(path).is_dir()
    }

    fn modified(&self, path: &str) -> Option<String> {
        fs::metadata(self.absolute(path))
            .ok()
            .and_then(|meta| meta.modified().ok())
            .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339())
    }
}
