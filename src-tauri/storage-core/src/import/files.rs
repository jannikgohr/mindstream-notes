//! How the importer reaches a source's files.
//!
//! The formats only need to walk a tree and read bytes, so they do it through
//! this trait. The app reads from disk. A browser reads from the files the
//! user picked, which it can do lazily, so that only one note's body is
//! resident at a time on either platform.
//!
//! Paths are relative to the source's root, with forward slashes everywhere.

use std::collections::BTreeMap;
use std::io::{self, Read};

/// A file or directory found by [`ImportFiles::walk`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportEntry {
    pub path: String,
    pub is_dir: bool,
}

pub trait ImportFiles {
    /// Every directory and file under the root, depth first, with each
    /// directory before its contents and siblings sorted by name. The order
    /// keeps a run reproducible, and parents must come before their children.
    ///
    /// An entry whose name `skip` matches is left out, a directory with
    /// everything inside it, and an unreadable path is skipped: one must not
    /// abort a vault-sized walk.
    fn walk(&self, skip: &dyn Fn(&str) -> bool) -> Vec<ImportEntry>;

    /// The names of the files directly in the root.
    fn root_files(&self) -> io::Result<Vec<String>>;

    fn read(&self, path: &str) -> io::Result<Vec<u8>>;

    /// Up to `length` bytes from `start`, fewer at the end of the file.
    fn read_range(&self, path: &str, start: u64, length: usize) -> io::Result<Vec<u8>>;

    /// The whole file as a stream, for one too large to hold in memory.
    fn stream(&self, path: &str) -> io::Result<Box<dyn Read>>;

    fn is_file(&self, path: &str) -> bool;

    fn is_dir(&self, path: &str) -> bool;

    /// When the file last changed, as RFC 3339.
    fn modified(&self, path: &str) -> Option<String>;
}

#[derive(Default)]
struct PathTree {
    children: BTreeMap<String, PathTree>,
}

impl PathTree {
    fn emit(&self, prefix: &str, skip: &dyn Fn(&str) -> bool, out: &mut Vec<ImportEntry>) {
        for (name, child) in &self.children {
            if skip(name) {
                continue;
            }
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            out.push(ImportEntry {
                path: path.clone(),
                is_dir: !child.children.is_empty(),
            });
            child.emit(&path, skip, out);
        }
    }
}

/// [`ImportFiles::walk`] for a source that is a list of file paths. Sorting
/// happens per directory, not on the whole path, because the order decides
/// which of two same-named attachments wins and must match a walk on disk.
pub fn walk_paths<'a>(
    paths: impl Iterator<Item = &'a str>,
    skip: &dyn Fn(&str) -> bool,
) -> Vec<ImportEntry> {
    let mut root = PathTree::default();
    for path in paths {
        let mut node = &mut root;
        for segment in path.split('/') {
            node = node.children.entry(segment.to_string()).or_default();
        }
    }
    let mut entries = Vec::new();
    root.emit("", skip, &mut entries);
    entries
}
