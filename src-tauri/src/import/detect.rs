//! Working out which format the user just pointed at.
//!
//! Detection is a hint, never a verdict: the import dialog shows what was
//! detected and lets the user override it, because a vault can be ambiguous
//! (an Obsidian vault with its `.obsidian` folder stripped is a GFM folder,
//! and importing it as one is perfectly reasonable).

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImportSourceKind {
    /// A folder of GitHub-flavoured markdown. Also what
    /// `mediawiki-to-markdown` produces.
    Gfm,
    /// An Obsidian vault — markdown plus wikilinks, embeds and inline tags.
    Obsidian,
    /// Joplin's lossless RAW export: a flat directory of `<id>.md` items.
    JoplinRaw,
    /// A Joplin `.jex` archive, which is a tar of the RAW layout.
    JoplinJex,
    /// Joplin's "Markdown + Front Matter" export.
    JoplinMarkdown,
}

impl ImportSourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gfm => "gfm",
            Self::Obsidian => "obsidian",
            Self::JoplinRaw => "joplin-raw",
            Self::JoplinJex => "joplin-jex",
            Self::JoplinMarkdown => "joplin-markdown",
        }
    }
}

/// What [`detect`] found, including the counts the dialog previews.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedSource {
    pub kind: ImportSourceKind,
    /// Absolute path the user picked, echoed back so the dialog can show it.
    pub path: String,
    /// Name to offer as the default destination folder.
    pub suggested_name: String,
}

pub fn detect(path: &Path) -> AppResult<DetectedSource> {
    if !path.exists() {
        return Err(AppError::NotFound(format!("{}", path.display())));
    }
    if !path.is_dir() {
        let Some(kind) = detect_file_kind(path) else {
            return Err(AppError::InvalidArg(
                "pick a folder of notes, or a Joplin .jex export".into(),
            ));
        };
        return Ok(DetectedSource {
            kind,
            path: path.to_string_lossy().to_string(),
            suggested_name: file_stem_name(path),
        });
    }
    Ok(DetectedSource {
        kind: detect_directory_kind(path),
        path: path.to_string_lossy().to_string(),
        suggested_name: suggested_name(path),
    })
}

/// Single-file sources, identified by extension.
fn detect_file_kind(path: &Path) -> Option<ImportSourceKind> {
    let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();
    match extension.as_str() {
        "jex" => Some(ImportSourceKind::JoplinJex),
        _ => None,
    }
}

/// Directory formats, in order of how specific their marker is.
///
/// Obsidian is identified by its `.obsidian` config directory and Joplin's
/// Markdown export by `_resources/` — the only markers those formats have. A
/// Joplin RAW export has no marker at all, so it is recognised by content:
/// its items carry a trailing `type_:` metadata block that nothing else
/// writes.
///
/// Every fallback lands on GFM, which is a reasonable way to import any folder
/// of markdown, and the dialog lets the user say otherwise.
fn detect_directory_kind(path: &Path) -> ImportSourceKind {
    if path.join(".obsidian").is_dir() {
        return ImportSourceKind::Obsidian;
    }
    if path.join("_resources").is_dir() {
        return ImportSourceKind::JoplinMarkdown;
    }
    if crate::import::sources::joplin_raw::looks_like_raw_export(path) {
        return ImportSourceKind::JoplinRaw;
    }
    ImportSourceKind::Gfm
}

/// Destination-folder name for an archive: the file name without its
/// extension, so `MyNotes.jex` suggests "MyNotes".
fn file_stem_name(path: &Path) -> String {
    path.file_stem()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Imported notes".to_string())
}

/// The folder's own name, falling back to something usable when the user
/// picked a drive root (whose file name is empty).
fn suggested_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Imported notes".to_string())
}
