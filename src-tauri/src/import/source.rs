//! The contract every import format implements.
//!
//! Two phases, and the split is what the whole design rests on:
//!
//! 1. [`ImportSource::index`] enumerates every item *without reading a body*
//!    and mints its note id. Cheap, and it means every id exists before any
//!    link is rewritten — so notes that reference each other need no second
//!    pass.
//! 2. [`ImportSource::load`] parses one item. Called once per item, with only
//!    that item's body resident, which is what keeps a million-note vault
//!    inside a sane memory budget.
//!
//! Adding a format is one module here plus a [`super::detect`] rule. Nothing
//! in the writer or the link index needs to know it exists.

use crate::error::AppResult;

use super::links::RewriteOptions;
use super::model::{AttachmentRef, ItemIndex, SourceIndex, StagedNote};

/// One parsed item: the note, plus the attachments its body still refers to by
/// source path. The orchestrator resolves those to asset ids after the note
/// row exists.
pub struct LoadedItem {
    pub note: StagedNote,
    pub attachments: Vec<AttachmentRef>,
}

pub trait ImportSource {
    /// Phase 1. Walk the source and enumerate what's there.
    fn index(&mut self) -> AppResult<SourceIndex>;

    /// Phase 2. Parse one indexed item.
    ///
    /// The body comes back with note links *not yet* rewritten — the
    /// orchestrator does that against the completed index — and with
    /// attachment references still pointing at source paths.
    fn load(&mut self, item: &ItemIndex) -> AppResult<LoadedItem>;

    /// Read one attachment's bytes. `None` means the file went missing
    /// between indexing and now, which is a skipped attachment, not a failed
    /// import.
    fn attachment_bytes(&mut self, reference: &AttachmentRef) -> AppResult<Option<Vec<u8>>>;

    /// Which link syntaxes this format uses. Plain GFM has no wikilinks, and
    /// running that pass over it would turn a `[[1]]` citation into a link.
    fn rewrite_options(&self) -> RewriteOptions;
}
