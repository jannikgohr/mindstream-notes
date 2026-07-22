/**
 * Background backfill of PDF search text.
 *
 * A PDF note becomes searchable once its extracted text is cached in
 * `notes.pdf_text` (see src-tauri/src/pdf_text.rs). The importing device does
 * that at import time, and the viewer does it on first open — but PDFs synced
 * in from another device (or imported before this feature shipped) would only
 * get indexed when opened. This sweep closes that gap: it walks every
 * un-indexed PDF note and extracts its text in the background, throttled so a
 * large vault doesn't jank the UI.
 *
 * Derived/local-only work: every step is best-effort and failures are
 * swallowed (the note simply stays un-indexed and is retried next sweep).
 */

import {
  fetchDrawingAsset,
  loadNote,
  pdfNotesMissingText,
  setPdfText
} from '$lib/api';
import { listen, TauriEventName } from '$lib/api/events';
import { extractPdfText } from './extract-text';
import { pdfAssetIdFromBody } from './viewer-helpers';

let running = false;
let rerunQueued = false;
let listenerArmed = false;

/** Yield to the browser between PDFs so indexing never blocks interaction. */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (
      globalThis as {
        requestIdleCallback?: (
          cb: () => void,
          opts?: { timeout: number }
        ) => void;
      }
    ).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 1000 });
    else setTimeout(resolve, 50);
  });
}

async function indexOne(noteId: string): Promise<void> {
  const note = await loadNote(noteId);
  const assetId = pdfAssetIdFromBody(note.body);
  if (!assetId) return;
  const asset = await fetchDrawingAsset(assetId);
  if (asset.mime_type !== 'application/pdf') return;
  const text = await extractPdfText(new Uint8Array(asset.bytes));
  await setPdfText(noteId, text);
}

async function sweep(): Promise<void> {
  if (running) {
    // A sweep is already in flight (e.g. a sync landed mid-run); coalesce
    // into a single follow-up pass rather than overlapping.
    rerunQueued = true;
    return;
  }
  running = true;
  try {
    do {
      rerunQueued = false;
      let ids: string[];
      try {
        ids = await pdfNotesMissingText();
      } catch (err) {
        console.debug('[pdf-index] missing-list query failed', err);
        break;
      }
      for (const id of ids) {
        try {
          await indexOne(id);
        } catch (err) {
          console.debug('[pdf-index] index failed', id, err);
        }
        await idle();
      }
    } while (rerunQueued);
  } finally {
    running = false;
  }
}

/**
 * Kick off PDF search indexing for this window and keep it fresh: an initial
 * sweep plus a re-sweep whenever a sync pull completes (which may have brought
 * in new PDF notes). Safe to call more than once — only the first call arms the
 * sync listener, and overlapping sweeps coalesce.
 */
export function startPdfSearchIndexing(): void {
  void sweep();
  if (listenerArmed) return;
  listenerArmed = true;
  void listen(TauriEventName.SyncCompleted, () => {
    void sweep();
  });
}
