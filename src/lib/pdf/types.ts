/**
 * Shared annotation model for PDF notes. Lives outside PdfNoteViewer.svelte
 * so the component, the export pipeline, and the sync tests can all agree
 * on a single shape — adding a field here forces every consumer to handle it.
 */

export type PdfAnnotationType = 'highlight' | 'comment' | 'ink' | 'signature';

export type PdfRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PdfStrokePoint = {
  x: number;
  y: number;
  pressure?: number;
};

export type PdfInkStroke = {
  id: string;
  points: PdfStrokePoint[];
  color: string;
  width: number;
};

export type PdfSignatureImage = {
  dataUrl: string;
  width: number;
  height: number;
  mimeType: 'image/png';
};

export type PdfSignatureSnapshot = {
  id: string;
  width: number;
  height: number;
  strokes: PdfInkStroke[];
  image?: PdfSignatureImage;
};

/**
 * Coordinates are in PDF user space (origin bottom-left, Y points up).
 * `rect.y` is the bottom edge of the annotation; `rect.y + rect.height`
 * is the top edge. Ink stroke points are in the same space.
 */
export type PdfAnnotation = {
  id: string;
  type: PdfAnnotationType;
  pageIndex: number;
  rects: PdfRect[];
  color: string;
  opacity: number;
  authorId: string;
  createdAt: string;
  updatedAt: string;
  body?: string;
  resolved?: boolean;
  deletedAt?: string;
  strokes?: PdfInkStroke[];
  signature?: PdfSignatureSnapshot;
};

export type PdfFormValue = Record<string, unknown>;

/** Yjs map key the PDF annotations live under, inside the note's Y.Doc. */
export const PDF_ANNOTATIONS_MAP = 'pdf_annotations';

/** Yjs map key for PDF.js AcroForm widget values, keyed by widget id. */
export const PDF_FORM_VALUES_MAP = 'pdf_form_values';
