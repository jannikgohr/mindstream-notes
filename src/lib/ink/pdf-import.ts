import { fetchAssetBytes, importInkPdfNote } from '$lib/api/assets';
import { loadNote } from '$lib/api/notes';
import { loadTree } from '$lib/stores/tree.svelte';
import { runSync } from '$lib/sync/runner';
import { buildPdfNoteBytes } from '$lib/note-exporters/pdf';
import { pdfAssetIdFromBody } from '$lib/pdf/viewer-helpers';
import { InkDocument } from './document';
import { indexInkNote, openPdf } from './pdf-backgrounds';
import {
  savePdfPageImages,
  savePageImage,
  type PageImageProgress
} from './page-images';
import { INK_PAGES, INK_META, INK_SCHEMA } from './page-document';
import type { InkPage } from './page';
import type { PdfAnnotation } from '$lib/pdf/types';
import { pageOffset } from './page-document';

function needsSnapshot(
  state: number[],
  includeInk: boolean,
  includeLegacyInk = true
): boolean {
  const ink = InkDocument.fromBytes(state);
  try {
    return (
      [...ink.doc.getMap<PdfAnnotation>('pdf_annotations').values()].some(
        (annotation) =>
          !annotation.deletedAt &&
          (includeLegacyInk || annotation.type !== 'ink')
      ) ||
      ink.doc.getMap('pdf_form_values').size > 0 ||
      (includeInk && ink.visibleStrokeCount() > 0)
    );
  } finally {
    ink.doc.destroy();
  }
}

export function parsePageRange(value: string, count: number): number[] {
  const result = new Set<number>();
  for (const part of value.split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match)
      throw new Error('Use page numbers or ranges, for example 1, 3-5.');
    const start = Number(match[1]),
      end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end > count)
      throw new Error(`Pages must be between 1 and ${count}.`);
    for (let i = start; i <= end; i++) result.add(i - 1);
  }
  return [...result];
}

export async function convertPdfToInk(
  noteId: string,
  progress?: PageImageProgress
): Promise<string> {
  const source = await loadNote(noteId);
  if (source.note_kind !== 'pdf') throw new Error('Choose a PDF note.');
  const sourceId = pdfAssetIdFromBody(source.body);
  if (!sourceId) throw new Error('PDF source is missing.');
  const bytes = needsSnapshot(source.yrs_state, true)
    ? await buildPdfNoteBytes(noteId)
    : await fetchAssetBytes(sourceId, 'application/pdf');
  const pdf = await openPdf(bytes);
  const ink = new InkDocument();
  try {
    const pages = await savePdfPageImages(
      pdf,
      Array.from({ length: pdf.numPages }, (_, i) => i),
      noteId,
      progress
    );
    ink.restorePages(pages);
    const note = await importInkPdfNote({
      title: source.title,
      parent_collection_id: source.parent_collection_id,
      bytes: [],
      asset_id: pages[0].background!.assetId,
      yrs_state: Array.from(ink.encode())
    });
    await loadTree();
    void indexInkNote(note.id).catch((error) =>
      console.warn('[ink] indexing failed', error)
    );
    void runSync().catch((error) => console.warn('[ink] sync failed', error));
    return note.id;
  } finally {
    ink.doc.destroy();
    await pdf.destroy();
  }
}

export async function preparePdfHandwriting(
  noteId: string,
  progress?: PageImageProgress
): Promise<InkPage[]> {
  const source = await loadNote(noteId);
  const assetId = pdfAssetIdFromBody(source.body);
  if (!assetId) throw new Error('PDF source is missing.');
  const saved = InkDocument.fromBytes(source.yrs_state);
  let signature: string;
  try {
    const annotations = [
      ...saved.doc.getMap<PdfAnnotation>('pdf_annotations').values()
    ]
      .filter((a) => !a.deletedAt && a.type !== 'ink')
      .sort((a, b) => a.id.localeCompare(b.id));
    signature = JSON.stringify([
      assetId,
      annotations,
      [...saved.doc.getMap('pdf_form_values').entries()].sort(([a], [b]) =>
        a.localeCompare(b)
      )
    ]);
    const pages = saved.pages();
    if (
      saved.hasPages() &&
      pages.length &&
      pages.every(
        (p) =>
          p.background?.kind === 'image' &&
          p.background.sourceSignature === signature
      )
    )
      return pages;
  } finally {
    saved.doc.destroy();
  }
  const bytes = needsSnapshot(source.yrs_state, false, false)
    ? await buildPdfNoteBytes(noteId, false, false)
    : await fetchAssetBytes(assetId, 'application/pdf');
  const pdf = await openPdf(bytes);
  try {
    return (
      await savePdfPageImages(
        pdf,
        Array.from({ length: pdf.numPages }, (_, i) => i),
        noteId,
        progress
      )
    ).map((p, i) => ({
      ...p,
      id: `pdf-page-${i}`,
      background: { ...p.background!, sourceSignature: signature }
    }));
  } finally {
    await pdf.destroy();
  }
}

/** Upgrade old background references a page at a time without touching strokes or order. */
export async function upgradePdfBackgrounds(
  noteId: string,
  ink: InkDocument,
  apply: (update: Uint8Array) => Promise<void>,
  progress?: PageImageProgress,
  signal?: AbortSignal
): Promise<void> {
  const originals = ink
    .pages()
    .filter((p) => p.background && p.background.kind !== 'image');
  const assets = [...new Set(originals.map((p) => p.background!.assetId))];
  let completed = 0;
  const textSources = new Map<string, Awaited<ReturnType<typeof openPdf>>>();
  try {
    for (const assetId of assets) {
      signal?.throwIfAborted();
      const pdf = await openPdf(
        await fetchAssetBytes(assetId, 'application/pdf')
      );
      try {
        for (const original of originals.filter(
          (p) => p.background!.assetId === assetId
        )) {
          signal?.throwIfAborted();
          const image = await savePageImage(
            await pdf.getPage(original.background!.pageIndex + 1),
            original.background!.pageIndex,
            noteId,
            signal
          );
          // Early flattened PDFs keep a separate text source.
          if (
            original.background!.textAssetId &&
            original.background!.textAssetId !== assetId
          ) {
            const id = original.background!.textAssetId!;
            let textSource = textSources.get(id);
            if (!textSource) {
              textSource = await openPdf(
                await fetchAssetBytes(id, 'application/pdf')
              );
              textSources.set(id, textSource);
            }
            const textPage = await textSource.getPage(
              original.background!.pageIndex + 1
            );
            const content = await textPage.getTextContent();
            image.background!.text = content.items
              .map((item) => ('str' in item ? item.str : ''))
              .join(' ');
            textPage.cleanup();
          }
          signal?.throwIfAborted();
          const current = ink.doc.getMap<InkPage>(INK_PAGES).get(original.id);
          if (
            current &&
            JSON.stringify(current.background) ===
              JSON.stringify(original.background)
          ) {
            const mutation = ink.transactLocalUpdate(() => {
              ink.doc.getMap<number>(INK_META).set('schema', INK_SCHEMA);
              ink.doc
                .getMap<InkPage>(INK_PAGES)
                .set(original.id, { ...current, background: image.background });
            });
            if (mutation.update) await apply(mutation.update);
          }
          progress?.(++completed, originals.length);
        }
      } finally {
        await pdf.destroy();
      }
    }
  } finally {
    await Promise.allSettled(
      [...textSources.values()].map((pdf) => pdf.destroy())
    );
  }
}

/** Upgrade app-created PDF ink to the shared tools using deterministic stroke IDs. */
export function migratePdfInk(ink: InkDocument): void {
  const annotations = ink.doc.getMap<PdfAnnotation>('pdf_annotations');
  const pages = ink.pages();
  for (const annotation of [...annotations.values()]) {
    if (annotation.type !== 'ink' || annotation.deletedAt) continue;
    const page = pages[annotation.pageIndex];
    if (!page) continue;
    const offset = pageOffset(pages, page.id)!;
    const [a, b, c, d, e, f] = page.pdfTransform ?? [
      2,
      0,
      0,
      -2,
      0,
      page.height
    ];
    ink.addStrokes(
      (annotation.strokes ?? []).map((stroke) => ({
        id: `pdf:${annotation.id}:${stroke.id}`,
        color:
          ((Math.round(annotation.opacity * 255) << 24) |
            parseInt(stroke.color.replace('#', ''), 16)) >>>
          0,
        width: stroke.width * 2,
        // Legacy PDF ink was displayed at a fixed width, even when pressure data existed.
        points: stroke.points.map((point) => ({
          x: a * point.x + c * point.y + e + offset.x,
          y: b * point.x + d * point.y + f + offset.y,
          pressure: 1
        }))
      }))
    );
    annotations.delete(annotation.id);
  }
  ink.resetUndoHistory();
}
