//! The format-neutral intermediate representation every import source
//! produces.
//!
//! Sources differ wildly — a directory of markdown, a tar of Joplin items, one
//! multi-gigabyte XML file — but they all reduce to "folders, notes, and the
//! links between them". Keeping that shape in one place is what lets
//! [`crate::import::writer`] and [`crate::import::links`] stay format-blind.

use crate::notes::NoteKind;

/// How strong a match an alias represents. Lower is stronger: a full relative
/// path beats a bare basename, which beats a fuzzy title match.
///
/// This ordering is the whole reason link resolution is predictable. Two notes
/// called `Index.md` in different folders both register the basename `index`,
/// but only one can own it — so a link written as `Notes/Index.md` still lands
/// on the right one, because the full path was registered at a stronger tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum AliasTier {
    /// The source's own identifier — a Joplin `:/id`, an Evernote guid.
    /// Unambiguous by construction.
    NativeId,
    /// Path relative to the import root, with and without the extension.
    FullPath,
    /// File name only, with and without the extension. Obsidian's
    /// shortest-path link style resolves through this.
    Basename,
    /// The note's title, case-folded.
    Title,
    /// Title with separators and punctuation flattened. Catches MediaWiki's
    /// `Foo_Bar` style targets, which is what a Wikipedia dump is full of.
    NormalizedTitle,
}

/// A folder discovered during phase 1.
#[derive(Debug, Clone)]
pub struct FolderIndex {
    /// Collection id, minted during the index pass so notes can reference it
    /// without a second lookup.
    pub id: String,
    /// Parent folder's minted id. `None` means "directly under the import
    /// destination".
    pub parent_id: Option<String>,
    pub name: String,
}

/// One importable note, discovered in phase 1 *without* reading its body.
#[derive(Debug, Clone)]
pub struct ItemIndex {
    /// The note id this item will get. Minted here, before any body is
    /// parsed, which is precisely what makes mutual links work: when phase 2
    /// rewrites note A's body, note B already has its id even though B has
    /// not been read yet.
    pub note_id: String,
    pub title: String,
    /// Minted folder id, or `None` for the import root.
    pub folder_id: Option<String>,
    /// Source-specific handle that [`super::source::ImportSource::load`] uses
    /// to find this item again — a relative path, an archive entry name, an
    /// offset.
    pub locator: String,
    /// Keys this item should answer to, registered into the link index before
    /// phase 2 begins.
    pub aliases: Vec<(AliasTier, String)>,
}

/// What phase 1 found. Also feeds the preview counts in the import dialog.
#[derive(Debug, Default)]
pub struct SourceIndex {
    pub folders: Vec<FolderIndex>,
    pub items: Vec<ItemIndex>,
}

/// An attachment referenced by a note, before its bytes have been read.
#[derive(Debug, Clone)]
pub struct AttachmentRef {
    /// Source handle for the bytes (relative path, resource id, …).
    pub locator: String,
    /// What the body currently writes, so the rewrite knows what to replace.
    pub placeholder: String,
    pub mime_type: String,
}

/// A fully parsed note, ready for the writer.
#[derive(Debug, Clone)]
pub struct StagedNote {
    pub note_id: String,
    pub title: String,
    pub folder_id: Option<String>,
    /// Markdown with links already rewritten to `mindstream://note/<id>` and
    /// attachments to `asset:mindstream/<id>`.
    pub body: String,
    pub tags: Vec<String>,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub note_kind: NoteKind,
}

/// What to do with a link whose target does not exist anywhere in the source.
///
/// Obsidian vaults and MediaWiki dumps are both full of these — Obsidian calls
/// them unresolved links, MediaWiki calls them red links — so the right answer
/// depends on the vault, not on us.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnresolvedLinks {
    /// Emit the link text without a link. The default: a wiki dump can
    /// reference millions of pages that were never exported, and inventing a
    /// note for each is worse than losing the link.
    #[default]
    PlainText,
    /// Mint an empty note for the target so the link works and clicking it
    /// lands somewhere. Mirrors what Obsidian does when you click an
    /// unresolved link.
    CreatePlaceholder,
}

/// Per-run counters surfaced in the result dialog.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ImportReport {
    pub notes_created: usize,
    pub folders_created: usize,
    /// Notes minted for link targets that weren't in the source.
    pub placeholders_created: usize,
    pub attachments_imported: usize,
    /// Attachments that resolved to bytes already stored, so no second copy
    /// was written.
    pub attachments_deduplicated: usize,
    /// Attachments skipped for exceeding the per-file size cap.
    pub attachments_too_large: usize,
    pub links_resolved: usize,
    /// Links left as plain text because nothing in the source matched.
    pub links_unresolved: usize,
    /// Items that failed to parse. The run continues past these.
    pub errors: usize,
    /// True when the user cancelled; everything already committed is kept.
    pub cancelled: bool,
}
