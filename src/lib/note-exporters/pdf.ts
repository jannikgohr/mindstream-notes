import * as Y from 'yjs';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { fetchDrawingAsset, loadNote, type Note } from '$lib/api';
import { saveAnnotatedPdf } from '$lib/api/pdf-export';
import { exportAnnotatedPdf } from '$lib/pdf/export-annotated-pdf';
import { sanitizePdfFilename } from '$lib/pdf/filename';
import { pdfAssetIdFromBody } from '$lib/pdf/viewer-helpers';
import {
  PDF_ANNOTATIONS_MAP,
  PDF_FORM_VALUES_MAP,
  type PdfAnnotation,
  type PdfFormValue
} from '$lib/pdf/types';
import type { NoteExporter } from './types';

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

function liveFormValuesFrom(note: Note): Map<string, PdfFormValue> {
  const doc = new Y.Doc();
  try {
    if (note.yrs_state.length > 0) {
      try {
        Y.applyUpdate(doc, new Uint8Array(note.yrs_state));
      } catch (err) {
        console.warn('[note-exporters/pdf] form state unreadable', err);
        return new Map();
      }
    }
    return new Map(doc.getMap<PdfFormValue>(PDF_FORM_VALUES_MAP).entries());
  } finally {
    doc.destroy();
  }
}

async function applyFormValuesToPdf(
  pdfBytes: Uint8Array,
  formValues: Map<string, PdfFormValue>
): Promise<Uint8Array> {
  if (formValues.size === 0) return pdfBytes;

  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(pdfBytes) });
  const doc = await task.promise;
  try {
    const storage = doc.annotationStorage;
    for (const [id, value] of formValues) {
      storage.setValue(id, value);
    }
    return await doc.saveDocument();
  } finally {
    await doc.cleanup();
    await task.destroy();
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

  const formFilledPdf = await applyFormValuesToPdf(
    new Uint8Array(asset.bytes),
    liveFormValuesFrom(note)
  );
  const out = await exportAnnotatedPdf(
    formFilledPdf,
    liveAnnotationsFrom(note)
  );

  await saveAnnotatedPdf({
    suggestedName: `${sanitizePdfFilename(note.title)}.pdf`,
    dialogTitle: 'Save annotated PDF',
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
