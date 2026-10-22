import * as Y from 'yjs';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { fetchAssetBytes, loadNote, type Note } from '$lib/api';
import { saveAnnotatedPdf } from '$lib/api/pdf-export';
import { exportAnnotatedPdf } from '$lib/pdf/export-annotated-pdf';
import {
  exportPrintReadyPdf,
  type PrintReadyWarning
} from '$lib/pdf/export-print-ready-pdf';
import { sanitizePdfFilename } from '$lib/pdf/filename';
import { pdfAssetIdFromBody } from '$lib/pdf/viewer-helpers';
import {
  PDF_ANNOTATIONS_MAP,
  PDF_FORM_VALUES_MAP,
  type PdfAnnotation,
  type PdfFormValue
} from '$lib/pdf/types';
import { pushToast } from '$lib/components/toast.svelte';
import { tUi } from '$lib/settings/i18n.svelte';
import type { NoteExporter } from './types';
import { sharedInkAnnotations } from '$lib/ink/pdf-annotations';

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

interface PdfNoteSources {
  note: Note;
  /** The note's PDF asset with its form values filled in. */
  pdfBytes: Uint8Array;
  annotations: PdfAnnotation[];
}

async function loadPdfNoteSources(
  noteId: string,
  includeSharedInk = true,
  includeLegacyInk = true
): Promise<PdfNoteSources> {
  const note = await loadNote(noteId);
  if (note.note_kind !== 'pdf') {
    throw new Error('This export is only available for PDF notes.');
  }

  const assetId = pdfAssetIdFromBody(note.body);
  if (!assetId) throw new Error('PDF asset is missing.');

  const bytes = await fetchAssetBytes(assetId, 'application/pdf');

  const pdfBytes = await applyFormValuesToPdf(bytes, liveFormValuesFrom(note));
  const annotations = [
    ...liveAnnotationsFrom(note).filter(
      (annotation) => includeLegacyInk || annotation.type !== 'ink'
    ),
    ...(includeSharedInk ? sharedInkAnnotations(note.yrs_state) : [])
  ];
  return { note, pdfBytes, annotations };
}

export async function buildPdfNoteBytes(
  noteId: string,
  includeSharedInk = true,
  includeLegacyInk = true
): Promise<Uint8Array> {
  const { pdfBytes, annotations } = await loadPdfNoteSources(
    noteId,
    includeSharedInk,
    includeLegacyInk
  );
  return exportAnnotatedPdf(pdfBytes, annotations);
}

export async function exportAnnotatedPdfNote(noteId: string): Promise<void> {
  const { note, pdfBytes, annotations } = await loadPdfNoteSources(noteId);
  await saveAnnotatedPdf({
    suggestedName: `${sanitizePdfFilename(note.title)}.pdf`,
    dialogTitle: 'Save annotated PDF',
    bytes: await exportAnnotatedPdf(pdfBytes, annotations)
  });
}

const PRINT_READY_WARNING_KEYS = {
  'form-not-flattened': 'pdf.export.printReady.formNotFlattened',
  'unsupported-characters': 'pdf.export.printReady.unsupportedCharacters'
} as const satisfies Record<PrintReadyWarning, string>;

export async function exportPrintReadyPdfNote(noteId: string): Promise<void> {
  const { note, pdfBytes, annotations } = await loadPdfNoteSources(noteId);
  const { bytes, warnings } = await exportPrintReadyPdf(pdfBytes, annotations, {
    commentsHeading: tUi('pdf.export.printReady.commentsHeading'),
    page: tUi('pdf.comments.page'),
    resolved: tUi('pdf.comments.resolved')
  });
  const saved = await saveAnnotatedPdf({
    suggestedName: `${sanitizePdfFilename(note.title)} (print).pdf`,
    dialogTitle: 'Save print-ready PDF',
    bytes
  });
  if (!saved) return;
  for (const warning of warnings) {
    pushToast(tUi(PRINT_READY_WARNING_KEYS[warning]), { durationMs: 0 });
  }
}

export const pdfExporters: NoteExporter[] = [
  {
    id: 'pdf.annotated',
    noteKind: 'pdf',
    label: 'Annotated PDF',
    run: exportAnnotatedPdfNote
  },
  {
    id: 'pdf.print-ready',
    noteKind: 'pdf',
    label: 'Print-ready PDF',
    run: exportPrintReadyPdfNote
  }
];
