//! Working out which format the user just pointed at.
//!
//! Detection is a hint, never a verdict: the import dialog shows what was
//! detected and lets the user override it, because a vault can be ambiguous
//! (an Obsidian vault with its `.obsidian` folder stripped is a GFM folder,
//! and importing it as one is perfectly reasonable).

use serde::{Deserialize, Serialize};

use super::files::ImportFiles;

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
    /// An Evernote `.enex` file.
    Evernote,
}

impl ImportSourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gfm => "gfm",
            Self::Obsidian => "obsidian",
            Self::JoplinRaw => "joplin-raw",
            Self::JoplinJex => "joplin-jex",
            Self::JoplinMarkdown => "joplin-markdown",
            Self::Evernote => "evernote",
        }
    }
}

/// What detection found, including the counts the dialog previews.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedSource {
    pub kind: ImportSourceKind,
    /// The path the user picked, echoed back so the dialog can show it.
    pub path: String,
    /// Name to offer as the default destination folder.
    pub suggested_name: String,
}

/// Single-file sources, identified by extension.
pub fn detect_file_kind(file_name: &str) -> Option<ImportSourceKind> {
    let (_, extension) = file_name.rsplit_once('.')?;
    match extension.to_ascii_lowercase().as_str() {
        "jex" => Some(ImportSourceKind::JoplinJex),
        "enex" => Some(ImportSourceKind::Evernote),
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
pub fn detect_directory_kind(files: &dyn ImportFiles) -> ImportSourceKind {
    if files.is_dir(".obsidian") {
        return ImportSourceKind::Obsidian;
    }
    if files.is_dir("_resources") {
        return ImportSourceKind::JoplinMarkdown;
    }
    if crate::import::sources::joplin_raw::looks_like_raw_export(files) {
        return ImportSourceKind::JoplinRaw;
    }
    ImportSourceKind::Gfm
}
