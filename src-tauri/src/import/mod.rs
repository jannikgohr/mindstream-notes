//! Vault import — bringing an external note collection into Mindstream.
//!
//! # Why this lives in Rust
//!
//! The notes-as-files *export* drives from TypeScript ([`crate::notes_export`]
//! is only a filesystem shim) because each note kind needs serialisation logic
//! whose types exist on the JS side. Import has the opposite shape: the input
//! is bytes on disk, the output is SQLite rows, and the target is a vault with
//! a million notes in it. One IPC round trip per file would dominate the run.
//!
//! # Two phases
//!
//! [`source::ImportSource`] splits the work in two, and that split is what
//! makes link preservation exact:
//!
//! 1. **Index** — enumerate every item without reading a body, minting each
//!    one's final note id.
//! 2. **Convert** — parse one item at a time, rewrite its links against the
//!    now-complete index, hand it to the writer.
//!
//! Because every id exists before any body is rewritten, notes that reference
//! each other resolve on the first pass. There is no second fixup pass, no
//! ordering requirement, and a cycle of any length is not a special case.
//!
//! # Memory
//!
//! Only one body is resident at a time. The structure that does scale with
//! vault size is the alias index in [`links::LinkIndex`] — several entries per
//! note, held for the whole run.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::app_events::AppEvent;
use crate::db::Db;
use crate::error::{AppError, AppResult, CommandResult};

pub mod detect;
pub mod links;
pub mod markdown;
pub mod mime;
pub mod model;
pub mod source;
pub mod sources;
pub mod stage;
pub mod writer;

#[cfg(test)]
mod tests;

pub use detect::{DetectedSource, ImportSourceKind};
pub use model::{ImportReport, UnresolvedLinks};

/// Notes written per transaction.
///
/// Small enough that a cancel loses almost nothing and the global connection
/// lock is handed back often enough to keep the UI responsive; large enough
/// that per-transaction overhead disappears against the row writes.
const BATCH_SIZE: usize = 500;

/// Default per-file attachment ceiling. Generous for a note vault, low enough
/// that one stray disk image doesn't quietly add gigabytes to the SQLite file.
pub const DEFAULT_MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
pub struct ImportOptions {
    pub source_path: String,
    /// Override for the detected format. `None` accepts the detection.
    #[serde(default)]
    pub kind: Option<ImportSourceKind>,
    /// Existing collection to import into. `None` means the vault root.
    #[serde(default)]
    pub destination_collection_id: Option<String>,
    /// When set, a new folder with this name is created under the destination
    /// and everything lands inside it. This is the default the dialog
    /// pre-selects: non-destructive, and undone by trashing one folder.
    #[serde(default)]
    pub create_folder_named: Option<String>,
    #[serde(default = "default_true")]
    pub import_attachments: bool,
    #[serde(default = "default_max_attachment_bytes")]
    pub max_attachment_bytes: u64,
    #[serde(default)]
    pub unresolved_links: UnresolvedLinks,
}

fn default_true() -> bool {
    true
}

fn default_max_attachment_bytes() -> u64 {
    DEFAULT_MAX_ATTACHMENT_BYTES
}

/// Progress ping. Throttled by note count rather than by time so a fast import
/// can't flood the IPC channel with thousands of events a second.
#[derive(Debug, Clone, Serialize)]
pub struct ImportProgress {
    pub phase: &'static str,
    pub done: usize,
    pub total: usize,
}

/// Cancellation flag, shared between the running import and `import_cancel`.
#[derive(Default)]
pub struct ImportState {
    cancelled: Arc<AtomicBool>,
}

impl ImportState {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    fn begin(&self) -> Arc<AtomicBool> {
        self.cancelled.store(false, Ordering::SeqCst);
        Arc::clone(&self.cancelled)
    }
}

fn build_source(
    kind: ImportSourceKind,
    root: PathBuf,
) -> AppResult<Box<dyn source::ImportSource + Send>> {
    use sources::evernote::EvernoteSource;
    use sources::joplin_raw::JoplinRawSource;
    use sources::markdown_vault::{Flavour, MarkdownVaultSource};
    match kind {
        ImportSourceKind::Gfm => Ok(Box::new(MarkdownVaultSource::new(root, Flavour::Gfm))),
        ImportSourceKind::Obsidian => {
            Ok(Box::new(MarkdownVaultSource::new(root, Flavour::Obsidian)))
        }
        ImportSourceKind::JoplinMarkdown => Ok(Box::new(MarkdownVaultSource::new(
            root,
            Flavour::JoplinMarkdown,
        ))),
        ImportSourceKind::JoplinRaw => Ok(Box::new(JoplinRawSource::new(root))),
        ImportSourceKind::JoplinJex => Ok(Box::new(JoplinRawSource::from_archive(&root)?)),
        ImportSourceKind::Evernote => Ok(Box::new(EvernoteSource::new(root))),
    }
}

/// Run an import to completion (or to cancellation) and report what landed.
pub fn run_import(
    db: &Db,
    options: ImportOptions,
    cancelled: &AtomicBool,
    mut on_progress: impl FnMut(ImportProgress),
) -> AppResult<ImportReport> {
    let root = PathBuf::from(&options.source_path);
    let detected = detect::detect(&root)?;
    let kind = options.kind.unwrap_or(detected.kind);
    let mut source = build_source(kind, root)?;

    let mut report = ImportReport::default();

    // ---- Phase 1: index ------------------------------------------------
    on_progress(ImportProgress {
        phase: "scanning",
        done: 0,
        total: 0,
    });
    let index = source.index()?;
    let total = index.items.len();

    // ---- Destination ---------------------------------------------------
    let destination = resolve_destination(db, &options)?;
    let share_scope_id = match destination.as_deref() {
        Some(id) => db.with_conn(|c| crate::sharing::collection_scope(c, id))?,
        None => None,
    };
    report.folders_created = writer::write_folders(
        db,
        &index.folders,
        destination.as_deref(),
        share_scope_id.as_deref(),
    )?;

    // ---- Link index ----------------------------------------------------
    // Every note id is registered before a single body is parsed. That is the
    // entire trick behind mutual links working on one pass.
    let mut link_index = links::LinkIndex::new(options.unresolved_links);
    for item in &index.items {
        link_index.register_item(item);
    }

    // ---- Phase 2: convert + write --------------------------------------
    let mut positions = writer::PositionCounters::default();
    let mut batch: Vec<writer::PreparedNote> = Vec::with_capacity(BATCH_SIZE);
    let rewrite_options = source.rewrite_options();

    for (processed, item) in index.items.iter().enumerate() {
        if cancelled.load(Ordering::SeqCst) {
            report.cancelled = true;
            break;
        }
        match prepare_item(
            source.as_mut(),
            item,
            &mut link_index,
            rewrite_options,
            &options,
            &mut report,
        ) {
            Ok(prepared) => batch.push(prepared),
            Err(err) => {
                // One unparseable file must not cost the user the other
                // 999,999. Count it and carry on.
                log::warn!("[import] item {} failed: {err}", item.locator);
                report.errors += 1;
            }
        }

        if batch.len() >= BATCH_SIZE {
            flush(
                db,
                &mut batch,
                destination.as_deref(),
                share_scope_id.as_deref(),
                &mut positions,
                &mut report,
            )?;
            on_progress(ImportProgress {
                phase: "importing",
                done: processed + 1,
                total,
            });
        }
    }
    flush(
        db,
        &mut batch,
        destination.as_deref(),
        share_scope_id.as_deref(),
        &mut positions,
        &mut report,
    )?;

    // ---- Placeholders --------------------------------------------------
    report.placeholders_created = writer::write_placeholders(
        db,
        link_index.placeholders(),
        destination.as_deref(),
        share_scope_id.as_deref(),
        &mut positions,
    )?;

    on_progress(ImportProgress {
        phase: "done",
        done: report.notes_created,
        total,
    });
    Ok(report)
}

fn flush(
    db: &Db,
    batch: &mut Vec<writer::PreparedNote>,
    destination: Option<&str>,
    share_scope_id: Option<&str>,
    positions: &mut writer::PositionCounters,
    report: &mut ImportReport,
) -> AppResult<()> {
    if batch.is_empty() {
        return Ok(());
    }
    let outcome = writer::write_batch(
        db,
        std::mem::take(batch),
        destination,
        share_scope_id,
        positions,
    )?;
    report.notes_created += outcome.notes;
    report.attachments_imported += outcome.attachments;
    report.attachments_deduplicated += outcome.attachments_deduplicated;
    Ok(())
}

fn prepare_item(
    source: &mut (dyn source::ImportSource + Send),
    item: &model::ItemIndex,
    link_index: &mut links::LinkIndex,
    rewrite_options: links::RewriteOptions,
    options: &ImportOptions,
    report: &mut ImportReport,
) -> AppResult<writer::PreparedNote> {
    let loaded = source.load(item)?;
    let mut note = loaded.note;

    let base_dir = item
        .locator
        .rfind('/')
        .map(|idx| item.locator[..idx].to_string())
        .unwrap_or_default();
    let mut stats = links::RewriteStats::default();
    note.body = links::rewrite_links(
        &note.body,
        link_index,
        &links::RewriteContext {
            options: rewrite_options,
            base_dir,
        },
        &mut stats,
    );
    report.links_resolved += stats.resolved;
    report.links_unresolved += stats.unresolved;

    let mut attachments = Vec::new();
    if options.import_attachments {
        for reference in loaded.attachments {
            let Some(bytes) = source.attachment_bytes(&reference)? else {
                continue;
            };
            if bytes.len() as u64 > options.max_attachment_bytes {
                report.attachments_too_large += 1;
                continue;
            }
            attachments.push((reference, bytes));
        }
    }

    Ok(writer::PreparedNote { note, attachments })
}

/// Work out the collection everything lands under, creating the default
/// "one new folder named after the source" when asked.
fn resolve_destination(db: &Db, options: &ImportOptions) -> AppResult<Option<String>> {
    let Some(name) = options.create_folder_named.as_deref() else {
        return Ok(options.destination_collection_id.clone());
    };
    let collection = db.with_conn(|conn| {
        crate::collections::create(
            conn,
            crate::collections::CreateCollection {
                name: name.to_string(),
                parent_collection_id: options.destination_collection_id.clone(),
            },
        )
    })?;
    Ok(Some(collection.id))
}

// ---------- Tauri commands ----------

#[tauri::command]
pub async fn notes_import_detect(path: String) -> CommandResult<DetectedSource> {
    // Blocking filesystem probing, off the async runtime's core threads.
    tauri::async_runtime::spawn_blocking(move || detect::detect(&PathBuf::from(path)))
        .await
        .map_err(|err| AppError::InvalidArg(err.to_string()))?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn notes_import_run(
    app: AppHandle,
    options: ImportOptions,
) -> CommandResult<ImportReport> {
    let cancelled = app.state::<ImportState>().begin();
    let progress_handle = app.clone();

    // spawn_blocking, not a plain call: an import is minutes of synchronous
    // filesystem and SQLite work, and running it on the command thread would
    // hold up the WebView's IPC.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let db = progress_handle.state::<Db>();
        run_import(&db, options, &cancelled, |progress| {
            if let Err(err) = progress_handle.emit(AppEvent::ImportProgress.as_str(), &progress) {
                log::warn!("[import] progress emit failed: {err}");
            }
        })
    })
    .await
    .map_err(|err| AppError::InvalidArg(err.to_string()))?;

    result.map_err(Into::into)
}

#[tauri::command]
pub fn notes_import_cancel(state: tauri::State<'_, ImportState>) -> CommandResult<()> {
    state.cancel();
    Ok(())
}
