import * as Y from 'yjs';
import { fetchDrawingAsset, loadNote, type Note } from '$lib/api';
import { saveAnnotatedPdf } from '$lib/api/pdf-export';
import { exportAnnotatedPdf } from '$lib/pdf/export-annotated-pdf';
import { sanitizePdfFilename } from '$lib/pdf/filename';
import { PDF_ANNOTATIONS_MAP, type PdfAnnotation } from '$lib/pdf/types';
import type { NoteExporter } from './types';

function pdfAssetIdFromBody(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('asset_')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { pdfAssetId?: unknown };
    return typeof parsed.pdfAssetId === 'string' ? parsed.pdfAssetId : null;
  } catch {
    return null;
  }
}

function liveAnnotationsFrom(note: Note): PdfAnnotation[] {
  const doc = new Y.Doc();
  try {
    if (note.yrs_state.length > 0) {
      try {
        Y.applyUpdate(doc, new Uint8Array(note.yrs_state));
      } catch (err) {
        console.warn('[note-exporters/pdf] annotation state unreadable', err);
        return [];
      }
    }
    return Array.from(
      doc.getMap<PdfAnnotation>(PDF_ANNOTATIONS_MAP).values()
    ).filter((annotation) => !annotation.deletedAt);
  } finally {
    doc.destroy();
  }
}

export async function exportAnnotatedPdfNote(noteId: string): Promise<void> {
  const note = await loadNote(noteId);
  if (note.note_kind !== 'pdf') {
    throw new Error('Annotated PDF export is only available for PDF notes.');
  }

  const assetId = pdfAssetIdFromBody(note.body);
  if (!assetId) throw new Error('PDF asset is missing.');

  const asset = await fetchDrawingAsset(assetId);
  if (asset.mime_type !== 'application/pdf') {
    throw new Error('Stored file is not a PDF.');
  }

  const out = await exportAnnotatedPdf(
    new Uint8Array(asset.bytes),
    liveAnnotationsFrom(note)
  );

  await saveAnnotatedPdf({
    suggestedName: `${sanitizePdfFilename(note.title)}.pdf`,
    bytes: out
  });
}

export const pdfExporters: NoteExporter[] = [
  {
    id: 'pdf.annotated',
    noteKind: 'pdf',
    label: 'Annotated PDF',
    run: exportAnnotatedPdfNote
  }
];
