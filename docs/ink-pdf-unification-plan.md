# Shared ink and PDF document plan

Status: implemented. Ink notes retain PDF appearance and extracted text for
cross-note search. The implementation keeps the existing canvas tools and
projects page-local strokes into the scrolling canvas. PDF notes open that same
editor for handwriting and retain their existing reader for PDF interactions.

## Confirmed behavior

- Converting an existing PDF note creates a new ink note. The PDF note stays.
- Importing a PDF into an ink note inserts full-page backgrounds among its pages.
- Imported pages keep their original dimensions and orientation, including
  mixed portrait and landscape pages within one ink note.
- The first version supports choosing source PDF pages, inserting blank pages,
  reordering pages, and deleting pages in ink notes.
- Ordinary PDF notes receive the same pen, eraser, lasso, and stroke editing
  tools as ink notes.
- PDF-backed ink pages preserve the source page's rendering as a fixed background.
  They use the ink editor's normal handwriting and navigation tools.
- Extract and save text from the imported PDF pages for the existing cross-note
  search engine. This does not require selectable text in the ink editor.
- Ordinary PDF notes retain their existing PDF reading and annotation features.

## Scope boundaries and remaining details

- Ink backgrounds do not expose PDF text selection, clickable links, editable
  form fields, or PDF-specific highlight/comment/signature tools. New marks are
  made with the shared handwriting tools.
- Cross-note search is included. An in-note text search UI, page-level result
  navigation, and visual search-hit rectangles are outside the agreed first
  version.
- New blank pages default to A4. Legacy ink notes keep their inferred trailing
  blank pages until a page operation materializes their explicit page list.
  Explicit documents retain exactly their saved pages and always keep one page.

No scope has been agreed for movable PDF objects, crop/rotate/background
replacement tools, OCR, or editing the page order of ordinary PDF notes. The
agreed ink-note page operations should not silently expand into those features.

## Background rendering and mobile behavior

Save each imported page as a compressed JPEG plus a smaller JPEG preview. Persist
its display dimensions, pixel dimensions, source page index, and extracted text.
PDF.js is used during import or the one-time upgrade of existing PDF-backed ink
notes. Opening, scrolling, zooming, thumbnails, search, and image-backed ink export
use the saved images and text, without parsing the source PDF again.

The raster size is 216 dpi for ordinary pages, capped at 6 million pixels and
4,096 pixels on the longest edge, with JPEG quality 0.9. Previews have a maximum
256-pixel edge at quality 0.8. Decoded page images use a bounded cache; retained
small previews prevent blank backgrounds while a full-size image loads.

Mobile ink notes keep the existing pen/eraser/lasso and navigation behavior,
including the finger-drawing setting. A separate Read mode and mobile text
selection controls are unnecessary for this scope. Verify Android's live-ink
overlay bounds against each page's actual size and orientation.

Conversion captures rendered annotations and filled form values in those JPEGs.
The source marks become fixed backgrounds; subsequent handwriting stays editable.
Nonvisual comment data is not imported as an editable discussion. The original
PDF note stays intact and retains its full PDF reading and export behavior.

## Extracted text and search

- Save each imported page's extracted text with its page record. Build the local
  FTS cache from these records, so rebuilding search does not require the PDF.
  Legacy PDF-backed pages retain their source-page extraction cache until upgraded.
- Only chosen source pages are rasterized and indexed. Importing pages 2 and 5
  must not match text found only on page 3.
- Assemble each ink note's searchable text from its current background pages in
  document order. Text remains available after conversion or source-note deletion
  because the ink note retains its own images and page text.
- Rebuild derived note text after import, page deletion/reordering, undo/history
  restore, and incoming sync changes to page backgrounds or order. Stroke-only
  edits do not require PDF text extraction. Deleting the last PDF-backed page
  must clear its old searchable text.
- Key the derived cache by the source asset identity, source page, and extraction
  version. Gate asynchronous note-index writes on a matching page-list revision
  or signature so a stale extraction cannot reintroduce deleted page text.
- Extend `src-tauri/src/pdf_text.rs` beyond its current PDF-only, write-once
  rules. Extend `search/mod.rs` and add a migration updating the FTS5 body
  expressions/triggers in `db/migrations.rs`, then backfill existing index rows.
  Updating snippets alone would leave the FTS candidate query unable to find ink
  notes by background text. Keep count/statistics behavior consistent where it
  uses the same extracted content.
- Extend `src/lib/pdf/search-index-backfill.ts` to rebuild PDF-backed ink notes
  after sync and when their source assets arrive late. Cache updates must remain
  local and leave note modification timestamps untouched. Import must remain
  usable when extraction fails; retry indexing in the background.
- Scans without embedded text remain visible and writable. OCR and handwriting
  recognition are outside this feature.

## What the code does today

### Ink

- `src/lib/components/DrawingNoteEditor.svelte` dispatches to
  `InkWebNoteEditor.svelte` on every platform. Comments in `api/notes.ts` still
  describe an older native-only implementation and should be corrected when
  touching these files.
- `src/lib/ink/document.ts` owns a Yjs `strokes` array. Each stroke contains an
  encoded payload and tombstone state. Geometry, selection, transforms, partial
  erasing, spatial indexing, and custom undo already exist under `src/lib/ink/`.
- `src/lib/ink/page.ts` describes one repeated page size. Stroke coordinates are
  global to a vertical document. `contentMaxY()` determines the page count,
  including a trailing blank page and a minimum of two pages.
- `src/lib/layout/page-layout.ts` defines the A4 ink dimensions as 1190 by 1684
  units. It also supplies page appearance and spacing tokens used by both
  editors. Ink's document gap is independently defined in `ink/page.ts`.
- `src/lib/ink/canvas-painter.ts` paints page fills, patterns, and strokes on a
  canvas. There is no PDF background source or explicit persistent page list.
- `src/lib/ink/save-controller.ts` batches Yjs updates. The Rust
  `drawing_save_ink_state` command calls `notes::save_yrs_state`, which merges
  updates into stored state. `InkWebCollabProvider` exchanges state vectors and
  updates through the existing encrypted room transport.
- `restoreInkSnapshot()` in `InkWebNoteEditor.svelte` clears current strokes and
  copies strokes from a snapshot. New document fields would not be restored by
  this implementation.
- `src/lib/notes-export/ink-pdf.ts` writes vector strokes onto newly created PDF
  pages. Export page count comes from stroke positions, so background-only pages
  would currently be omitted.

### PDF

- `src-tauri/src/assets/mod.rs::import_pdf_note_inner` creates a `pdf` note and
  stores the original bytes as an asset. The note body is JSON containing one
  `pdfAssetId`.
- `src/lib/stores/tree.svelte.ts::importPdfIn` connects the file picker to that
  API, updates the tree, starts text extraction, and triggers sync. Desktop,
  native-menu, and mobile import paths use it.
- `src/lib/components/PdfNoteViewer.svelte` owns the PDF viewer's Y.Doc,
  annotation state, form values, save scheduling, history, and collaboration.
- `src/lib/pdf/page-render.ts` wraps PDF.js page rendering. It already supports
  text and form layers, cancellation, page render limits, and separate overlays.
  `page-render-window.ts` handles the active render window.
- `src/lib/pdf/types.ts` stores annotations in `pdf_annotations` and form values
  in `pdf_form_values`. Annotations use numeric `pageIndex` and PDF coordinates
  with an upward Y axis. Ink uses a downward Y axis.
- `src/lib/pdf/page-overlays.ts` owns the current PDF pen input and annotation
  interactions. Its pen uses a fixed width and does not record pointer pressure.
  `pdf/stroke-utils.ts` has a separate outline renderer also used by signatures.
- `src/lib/note-exporters/pdf.ts` applies saved form values, then exports app
  annotations through `pdf/export-annotated-pdf.ts`. Bulk vault export in
  `src/lib/notes-export/index.ts` currently copies the original PDF asset.
- `src-tauri/src/pdf_text.rs`, `search/mod.rs`, and
  `src/lib/pdf/search-index-backfill.ts` assume searchable PDF content belongs
  to notes whose kind is `pdf`.

### Shared infrastructure already available

Both paths use Yjs/Yrs state, the same note table, encrypted room transport,
`createCollabSession`, save scheduling, history capture, toolbar components,
hotkey routing, and common page presentation tokens. Sharing logic does not
require changing the backend sync protocol or introducing another note kind.
Any persisted-schema change still needs compatibility testing across clients.

## Recommended architecture

Keep `ink` and `pdf` as user-facing note types. Extract reusable document and
handwriting modules that both editors consume. Keep PDF-specific reading tools
and form behavior in PDF modules. Avoid a single component owning both entire
editors.

### Explicit pages and stable IDs

Introduce a versioned page document inside the existing Y.Doc:

- Each page has a stable ID, dimensions, and either a blank/pattern background
  or an image asset, preview asset, pixel dimensions, extracted text and source
  page index. Legacy PDF references remain readable for automatic upgrades.
- Page order is independent of identity. Reordering a page must not change the
  owner of its strokes, annotations, or search results.
- Strokes belong to a page and use page-local coordinates. Keep the current
  ink units for existing ink pages, and use explicit PDF viewport transforms
  at PDF boundaries. Handle crop boxes and source rotation through PDF.js
  transforms rather than assuming a zero-origin A4 source.
- The persisted page list determines document length and export length.
  Background-only pages are real content. Any automatic trailing blank page
  must be distinguished from a blank page the user explicitly inserted.
- Choose CRDT ordering semantics with tests for concurrent moves and deletion.
  A naive remove-and-reinsert of page records can duplicate or lose identity.

Mixed page sizes retain their source dimensions and orientation, as confirmed.
Fit-width zoom, page centering, hit testing, Android overlay bounds, and export
must use each page's dimensions rather than a document-wide A4 size. Preserve
physical page sizes on export independently of the editor's coordinate units.

### One handwriting engine

Extract pointer sampling, pressure handling, stroke style, hit testing, erasing,
lasso operations, and stroke commands from the ink editor. Both editors should
use the same stroke representation and drawing rules, with adapters for canvas,
PDF overlays, and PDF export. Choose a canonical pressure/width rule explicitly;
the current ink polyline painter and PDF outline painter render differently.

Retain the existing room transport and editor lifecycle helpers. Consolidate
document operations and save/undo behavior only where both editors need the
same behavior. This avoids making a transport rewrite a dependency of import.

### PDF backgrounds and imports

Use the shared `page-images.ts` service for conversion, selected-page imports,
and existing-note upgrades. Open the source once, render/compress one page at a
time, and upload each JPEG and preview in the destination share scope. Release
source-page decoding resources between pages and destroy the PDF worker after
completion. New imports into ink notes do not retain the entire source PDF blob.

Conversion creates independent editable state and registers image references in
one transaction. Original PDF notes stay intact. Existing ink notes upgrade in
place without changing page IDs, order, dimensions, or strokes. Persist each
upgraded page before continuing, cancel work when the editor closes, and reject
stale background writes if sync changes a page during conversion. Ink page schema
2 identifies the saved-image format; schema 1 remains readable for upgrades.

## Storage and lifecycle work that cannot be skipped

- Add a common collector for page-background asset references in current Yjs
  state and retained history. Existing `count_asset_refs()` only recognizes
  body URLs and the single `pdfAssetId` JSON field.
- Register references on saves, note creation/conversion, incoming note state,
  and incoming assets. `sync/apply/assets.rs` currently discovers other
  referencing notes by searching their bodies, which misses Yjs-only pages.
- Extend `sync/yrs_doc.rs::replace_asset_id` to visit the new page records.
  Today it explicitly opens the legacy body, ProseMirror, and Excalidraw roots.
- Apply scope remaps in the ink save path too. `save_yrs_state()` currently
  merges bytes without the normalization performed by the general note update
  path. This matters when an editor remains open during a share-scope move.
- Restore pages, backgrounds, and strokes together from
  history. Retain source assets while undo or a retained snapshot can need them.
- Treat import failure and cancellation deliberately. Avoid partially created
  destination notes and unreferenced blobs, and allow unavailable synced assets
  to load later without destroying the page references.
- Index PDF-backed ink pages and invalidate derived
  text when their source pages or order change. The current PDF-only write-once
  index cannot represent this.

## Migration and compatibility

Existing ink states have no page IDs or explicit page metadata. Read them through
a legacy adapter first. Migration must preserve visible geometry, stroke widths,
empty-page policy, and content across page boundaries. Strokes crossing a page
edge need clipping/splitting rules that preserve the original appearance.

Existing PDFs keep their source binary and annotations. An adapter can project
their source page indexes into stable page IDs. Preserve existing stroke
appearance while adapting legacy PDF ink; do not silently reinterpret pressure.

Make migration deterministic and idempotent so two devices do not create two
sets of pages. Decide how older clients are prevented from editing a document
schema they do not understand. `KNOWN_NOTE_KINDS` alone cannot protect a new
schema stored under an already-known `ink` or `pdf` kind.

## Implementation sequence

1. Write fixtures for old ink/PDF state, mixed page dimensions, rotated/cropped
   PDF pages, and conversion of current annotation/form appearances.
2. Introduce the page model, legacy readers, coordinate adapters, and page-aware
   commands. Verify migration and concurrent page operations independently of UI.
3. Add state/history asset collection, remapping, save integration, incoming
   sync handling, and transactional import/conversion persistence.
4. Extract shared handwriting logic and connect both ink and PDF editors. Preserve
   Android's live wet-ink overlay, document bounds, and stylus behavior.
5. Add PDF backgrounds and import/conversion UI, then source-page selection,
   blank-page insertion, reordering, and deletion in ink notes. Add page-scoped
   extracted-text caching and cross-note search integration. Keep expensive PDF
   rendering and extraction off the pen event path.
6. Update single-note and vault PDF exports. Preserve source page content as
   saved JPEG backgrounds with vector handwriting, and export
   explicit blank/background-only pages in document order.
7. Finish migration, history, sync, share-scope, performance, and desktop/mobile
   acceptance checks before enabling the new schema for editing.

## Validation required during implementation

- Unit coverage for coordinate transforms, page identity/order, legacy readers,
  clipping, stroke appearance, import page selection, and export page composition.
- Search coverage for selected source pages, deletion of the last background,
  reordering, failed/late extraction, stale asynchronous writes, source-note
  deletion, history restore, and FTS migration/backfill.
- Yjs concurrency cases for drawing during page insertion, reordering/deletion,
  undo of import, and two-device migration.
- Rust integration coverage for asset lifetimes, source-note deletion after
  conversion, history restoration, scope remaps, late saves, and both possible
  note/asset arrival orders during sync.
- Browser flows for importing into an existing note, converting without changing
  the PDF note, writing/erasing/lasso-selecting strokes on a background, reopening,
  cross-note search by background text, and export.
- Desktop and Android checks for pen pressure, palm/finger policy, zoom, scrolling,
  live overlay bounds, and large-document cancellation/cache behavior.
- Run the repository's frontend checks and tests, plus affected Rust tests. The
  validation results below record the checks run for this implementation.

## Implementation and verification

- PDF-to-ink conversion is offered in the PDF note's file-tree context menu.
  The reader has no extra handwriting/conversion header. Its existing pen tool
  opens the shared tools, with a return arrow in the ink toolbar.
- Native PDF import, background upload, reading and search extraction use binary
  IPC. Uploads return metadata without echoing the file. Converted ink notes
  reference independent compressed page images within the same share scope.
- The PDF page picker keeps one parsed document open until insertion or close,
  reads only selected page dimensions, and releases its worker and blob URL.
  The 102,395,904-byte, 14-page sample prepared in 857 ms and rendered/compressed/
  imported in 1,385 ms in the Chromium browser-fallback benchmark. It produced
  3,312,162 bytes of page JPEGs and 134,050 bytes of previews. These timings include
  browser mock-store persistence, not native SQLite/IPC or sync.

- `InkDocument` now owns explicit page records, page order and deletion roots,
  migration of legacy strokes, page-local payloads, and page undo/history restore.
  Renderer and viewport helpers accept differently sized pages.
- The right-aligned page-sorter icon opens `InkPageManager.svelte` as a thumbnail
  drawer. Mouse/touch drag handles and keyboard arrows reorder pages; each page's
  menu provides movement, blank insertion and deletion. Clicking a thumbnail
  navigates to the page. PDF range import remains in the drawer footer.
  `InkPageThumbnail.svelte` loads previews only as they become visible, using a
  shared bounded image cache and page-local strokes. `pdf-backgrounds.ts` manages bounded rendering and
  legacy source-page text caching. Stale legacy PDF renders are cancelled.
- `PdfDocumentEditor.svelte` switches ordinary PDF notes between their reader and
  the shared handwriting editor. Legacy app-created PDF ink migrates to editable
  shared strokes with deterministic IDs. Reader and export adapt shared strokes
  back to PDF coordinates, preserving pressure.
- PDF-to-ink conversion creates the destination and registers its background
  references in one SQLite transaction. Original PDF notes are retained. Asset collection/remapping
  handles current page state, deleted pages retained for undo, and existing
  history snapshot rewriting.
- Migration 34 updates FTS expressions and adds derived text metadata and a
  per-source-page cache. Background signatures reject stale extraction results.
- Single-note and bulk exports include backgrounds and handwriting. Source page
  sizes, crop boxes, rotation, and deliberately blank pages are retained.
- Frontend unit suite: 3,424 tests passed. Focused ink/PDF tests cover legacy
  migration, pressure, history restore, mixed-size export, crop, and rotation.
- Rust suite: 1,026 passed, six pre-existing platform/environment tests ignored.
- Browser integration: both PDF/ink flows and the optional large-file raster import passed in Chromium. Svelte checks,
  theme/i18n lint, and the production build passed during implementation.
- Tool changes retain the mounted editor across native plugin-settings refreshes.
  Resize notifications preserve the viewport instead of fitting back to the top.
  The regression fails against the old host code. Native Windows checks with the
  existing 100 MB PDF ink note retained scroll position while switching pen,
  eraser, and lasso at fit-width zoom and while returning to pen at 75% zoom.
- Physical Android pen/palm behavior and mixed-version editing with older app
  releases still need device/release validation. The new reader rejects unknown
  future ink schemas; older released apps cannot understand these page records.
