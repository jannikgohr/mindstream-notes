/**
 * The stroke shapes the ink layer passes around.
 *
 * Kept apart from `InkDocument` so the geometry, codec and undo helpers
 * can type themselves without importing the document (and the Yjs
 * runtime) along with it.
 */

import type { InkPoint } from '$lib/ink/page';

export const DEFAULT_COLOR = 0xff000000;
export const DEFAULT_WIDTH = 4;

export interface InkStroke {
  id: string;
  color: number;
  width: number;
  points: InkPoint[];
  bounds?: StrokeBounds;
}

export interface StrokeTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  widthScale: number;
}

export interface InkStrokeInput {
  color: number;
  width: number;
  points: InkPoint[];
}

export interface StrokeStyleSnapshot {
  id: string;
  color: number;
  width: number;
}

export interface StrokeStylePatch {
  color?: number;
  width?: number;
}

export type UndoOp =
  | { kind: 'strokeAdded'; id: string }
  | { kind: 'strokesAdded'; ids: string[] }
  | { kind: 'eraserDrag'; ids: string[] }
  | {
      kind: 'strokeSlice';
      // Original strokes tombstoned by the partial eraser.
      removedOriginals: string[];
      // Every fragment stroke created during the drag (intermediate + final).
      addedFragments: string[];
      // Fragments still visible when the drag ended (added minus re-erased).
      finalFragments: string[];
    }
  | { kind: 'clearAll'; ids: string[] }
  | { kind: 'selectionDelete'; ids: string[] }
  | { kind: 'selectionMove'; ids: string[]; dx: number; dy: number }
  | {
      kind: 'selectionTransform';
      ids: string[];
      transform: StrokeTransform;
      inverse: StrokeTransform;
    }
  | {
      kind: 'selectionStyle';
      before: StrokeStyleSnapshot[];
      after: StrokeStyleSnapshot[];
    };

export interface DecodedPayload {
  color: number;
  width: number;
  points: InkPoint[];
}

export interface StrokeBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface StrokeMeta extends InkStroke {
  bounds: StrokeBounds;
}

export interface StrokeSpatialIndex {
  tileSize: number;
  buckets: Map<string, StrokeMeta[]>;
  maxStrokeWidth: number;
}

export interface InProgressStroke {
  color: number;
  width: number;
  points: InkPoint[];
}

export interface MutationResult<T> {
  value: T;
  update: Uint8Array | null;
}

export function strokeFromMeta(meta: StrokeMeta): InkStroke {
  return {
    id: meta.id,
    color: meta.color,
    width: meta.width,
    points: meta.points,
    bounds: meta.bounds
  };
}
