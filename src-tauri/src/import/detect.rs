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
}

impl ImportSourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gfm => "gfm",
            Self::Obsidian => "obsidian",
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
        return Err(AppError::InvalidArg(
            "pick a folder containing markdown files".into(),
        ));
    }
    Ok(DetectedSource {
        kind: detect_directory_kind(path),
        path: path.to_string_lossy().to_string(),
        suggested_name: suggested_name(path),
    })
}

/// An Obsidian vault is identified by its `.obsidian` config directory — the
/// only marker the format has. A vault whose config was stripped reads as a
/// GFM folder, which is a perfectly reasonable way to import it, and the
/// dialog lets the user say otherwise.
fn detect_directory_kind(path: &Path) -> ImportSourceKind {
    if path.join(".obsidian").is_dir() {
        return ImportSourceKind::Obsidian;
    }
    ImportSourceKind::Gfm
}

/// The folder's own name, falling back to something usable when the user
/// picked a drive root (whose file name is empty).
fn suggested_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Imported notes".to_string())
}
