/**
 * Recognized handwriting, stored in the note so it syncs: one entry per page
 * in the `ink:handwriting` map, holding the text and a signature of the
 * strokes it was read from. A page whose strokes no longer match its
 * signature is read again; pages without strokes lose their entry.
 */

import type * as Y from 'yjs';
import type { InkDocument } from './document';
import type { InkPage } from './page';
import type { InkStroke } from './stroke-types';
import { drawStroke } from './canvas-painter';
import { cssColor } from './editor-helpers';
import { boundsOfPoints } from './stroke-geometry';

export const INK_HANDWRITING = 'ink:handwriting';

interface RecognizedPage {
  text: string;
  signature: string;
}

function recognizedPages(doc: Y.Doc) {
  return doc.getMap<unknown>(INK_HANDWRITING);
}

function isRecognizedPage(value: unknown): value is RecognizedPage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RecognizedPage).text === 'string' &&
    typeof (value as RecognizedPage).signature === 'string'
  );
}

/** `[pageId, signature]` rows in key order, the same rows `ink_background_signature` signs in Rust. */
export function recognizedSignatures(doc: Y.Doc): Array<[string, string]> {
  return [...recognizedPages(doc).entries()]
    .flatMap(
      ([id, value]): Array<[string, string]> =>
        isRecognizedPage(value) ? [[id, value.signature]] : []
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function recognizedText(doc: Y.Doc): Map<string, string> {
  const text = new Map<string, string>();
  for (const [id, value] of recognizedPages(doc).entries())
    if (isRecognizedPage(value) && value.text) text.set(id, value.text);
  return text;
}

export function strokeSignature(strokes: InkStroke[]): string {
  let hash = 0x811c9dc5;
  const mix = (n: number) => {
    hash = Math.imul(hash ^ (n & 0xffff), 0x01000193) >>> 0;
  };
  for (const stroke of strokes) {
    mix(stroke.points.length);
    for (const point of stroke.points) {
      mix(Math.round(point.x));
      mix(Math.round(point.y));
    }
  }
  return `${strokes.length}:${hash.toString(36)}`;
}

export interface PageToRecognize {
  page: InkPage;
  strokes: InkStroke[];
  signature: string;
}

export function pagesToRecognize(ink: InkDocument): PageToRecognize[] {
  const recognized = recognizedPages(ink.doc);
  return ink.pages().flatMap((page) => {
    const strokes = ink.pageStrokes(page.id);
    if (strokes.length === 0) return [];
    const signature = strokeSignature(strokes);
    const entry = recognized.get(page.id);
    return isRecognizedPage(entry) && entry.signature === signature
      ? []
      : [{ page, strokes, signature }];
  });
}

/** Drops entries for pages that were deleted or no longer have strokes. */
export function pruneRecognized(ink: InkDocument): Uint8Array | null {
  const recognized = recognizedPages(ink.doc);
  const written = new Set(
    ink
      .pages()
      .filter((page) => ink.pageStrokes(page.id).length > 0)
      .map((page) => page.id)
  );
  const stale = [...recognized.keys()].filter((id) => !written.has(id));
  if (stale.length === 0) return null;
  return ink.transactLocalUpdate(() => {
    for (const id of stale) recognized.delete(id);
  }).update;
}

/**
 * Reads every page whose strokes changed since it was last read. A page
 * edited while its request runs is stored under the old signature and read
 * again on the next pass.
 */
export async function recognizeInk(
  ink: InkDocument,
  recognize: (strokes: InkStroke[]) => Promise<string>,
  apply: (update: Uint8Array) => void,
  signal: AbortSignal
): Promise<void> {
  const pruned = pruneRecognized(ink);
  if (pruned) apply(pruned);
  for (const { page, strokes, signature } of pagesToRecognize(ink)) {
    const text = (await recognize(strokes)).trim();
    if (signal.aborted) return;
    const { update } = ink.transactLocalUpdate(() => {
      recognizedPages(ink.doc).set(page.id, { text, signature });
    });
    if (update) apply(update);
  }
}

const MAX_IMAGE_SIDE = 1600;
const IMAGE_PADDING = 24;

/** The strokes alone, cropped to their bounds, on white, as a PNG data URL. */
export function renderStrokesPng(strokes: InkStroke[]): string {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const stroke of strokes) {
    const bounds = boundsOfPoints(stroke.points);
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  }
  const x0 = minX - IMAGE_PADDING;
  const y0 = minY - IMAGE_PADDING;
  const width = maxX - minX + IMAGE_PADDING * 2;
  const height = maxY - minY + IMAGE_PADDING * 2;
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const view = {
    width: canvas.width,
    height: canvas.height,
    scale,
    panX: -x0 * scale,
    panY: -y0 * scale
  };
  const colors = new Map<number, string>();
  for (const stroke of strokes)
    drawStroke(
      ctx,
      stroke.points,
      cssColor(stroke.color, colors),
      stroke.width,
      view
    );
  return canvas.toDataURL('image/png');
}
