# Handwritten notes and PDFs

Handwritten notes and PDFs stay separate note kinds but share one handwriting
editor. A PDF note opens its reader for PDF work and switches to the shared
editor in [`PdfDocumentEditor.svelte`](../../src/lib/components/PdfDocumentEditor.svelte)
when the pen tool is picked. Converting a PDF note creates a new handwritten
note and leaves the PDF note as it was.

## Pages

[`page-document.ts`](../../src/lib/ink/page-document.ts) keeps the pages in the
note's Y.Doc: page records in `ink:pages`, their order in `ink:pageOrder`,
deleted pages in `ink:deletedPages` and the schema version in `ink:meta`.

- A page's id never changes. Reordering writes `ink:pageOrder` only, so strokes,
  search text and undo keep pointing at the same page.
- Strokes use page-local coordinates, so pages can differ in size and
  orientation. Imported PDF pages are scaled to the width of a blank A4 page and
  keep their aspect ratio. PDF notes keep the source page sizes their
  handwriting is anchored to.
- Deleted pages stay in the document so undo and history can bring them back,
  with their background assets.
- Older handwritten notes have no page records. They are read as legacy pages
  and get an explicit page list on their first page operation. A note with only
  blank pages still grows a page when the last one is written on; a note with
  PDF backgrounds keeps exactly its saved pages.

## PDF backgrounds

In the shared handwriting editor, PDF.js runs only when pages are imported or
an older PDF-backed note is upgraded. The PDF note's own reader still renders
with PDF.js. [`page-images.ts`](../../src/lib/ink/page-images.ts) saves each page as
a JPEG at 216 dpi, capped at 6 million pixels and 4,096 pixels on the longest
edge, at quality 0.9, plus a preview of at most 256 pixels at quality 0.8.
Opening, scrolling, thumbnails, search and export use these images and never
parse the PDF again. Annotations and form values are baked into the image;
handwriting added afterwards stays editable.

Background assets are referenced from Yjs state, not from the note body, so the
asset collector, scope remapping and history rewriting all walk the page records
as well. Conversion creates the note and registers its assets in one SQLite
transaction.

## Search

Each imported page saves its extracted text with the page record, and only the
pages someone picked are indexed. The note's searchable text is the text of its
current background pages in order. It is rebuilt after imports, page deletion
or reordering, history restores and incoming sync, and a stale extraction is
rejected by its background signature so it cannot bring back a deleted page's
text. Scans without embedded text stay writable but are not searchable.

## Compatibility

`InkDocument` refuses a schema newer than `INK_SCHEMA` instead of editing it.
App releases from before the page model cannot read page records, so editing
one note across old and new releases is unsupported.

## Not built

These were left out on purpose. Ask before letting the page tools grow into
them:

- PDF text selection, links, form fields or PDF annotation tools on a
  background. Marks are made with the handwriting tools.
- Search inside a note, page-level result navigation and hit rectangles.
- Movable PDF objects, cropping, rotating or replacing backgrounds, OCR, and
  reordering the pages of a PDF note.

## Still to check on devices

- Pen and palm behaviour on a physical Android device, including the live ink
  overlay on pages of different sizes.
