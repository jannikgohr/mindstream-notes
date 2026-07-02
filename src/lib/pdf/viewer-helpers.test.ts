import { describe, expect, it } from 'vitest';
import {
  annotationIdAtPoint,
  buildPdfAnnotation,
  clampZoom,
  clonePdfFormValue,
  isCommentLikeAnnotation,
  MAX_ZOOM,
  MIN_ZOOM,
  pdfAssetIdFromBody
} from './viewer-helpers';
import type { PdfAnnotation } from './types';

describe('pdfAssetIdFromBody', () => {
  it('returns null for blank bodies', () => {
    expect(pdfAssetIdFromBody('')).toBeNull();
    expect(pdfAssetIdFromBody('   ')).toBeNull();
  });

  it('returns a bare asset_ id directly', () => {
    expect(pdfAssetIdFromBody('asset_abc123')).toBe('asset_abc123');
    expect(pdfAssetIdFromBody('  asset_xyz  ')).toBe('asset_xyz');
  });

  it('extracts pdfAssetId from a JSON body', () => {
    expect(pdfAssetIdFromBody('{"pdfAssetId":"asset_42"}')).toBe('asset_42');
  });

  it('returns null when JSON lacks a string pdfAssetId', () => {
    expect(pdfAssetIdFromBody('{"pdfAssetId":123}')).toBeNull();
    expect(pdfAssetIdFromBody('{"other":"x"}')).toBeNull();
  });

  it('returns null for non-JSON, non-asset bodies', () => {
    expect(pdfAssetIdFromBody('just some text')).toBeNull();
  });
});

describe('clampZoom', () => {
  it('passes through values inside the range', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(2.5)).toBe(2.5);
  });

  it('clamps below the minimum and above the maximum', () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
  });
});

describe('clonePdfFormValue', () => {
  it('deep-clones a plain object', () => {
    const input = { a: 1, nested: { b: 2 } };
    const out = clonePdfFormValue(input) as typeof input;
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(out.nested).not.toBe(input.nested);
  });

  it('rejects null, arrays and primitives', () => {
    expect(clonePdfFormValue(null)).toBeNull();
    expect(clonePdfFormValue([1, 2])).toBeNull();
    expect(clonePdfFormValue('x')).toBeNull();
    expect(clonePdfFormValue(7)).toBeNull();
  });

  it('returns null when the value is not JSON-serialisable', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(clonePdfFormValue(circular)).toBeNull();
  });
});

describe('buildPdfAnnotation', () => {
  const base = {
    id: 'a1',
    pageIndex: 0,
    color: '#facc15',
    authorId: 'me',
    now: '2024-01-01T00:00:00Z'
  };

  it('wraps a single rect into a rects array', () => {
    const ann = buildPdfAnnotation({
      ...base,
      type: 'comment',
      rect: { x: 1, y: 2, width: 3, height: 4 }
    });
    expect(ann.rects).toHaveLength(1);
    expect(ann.rects[0]).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it('keeps an array of rects as-is', () => {
    const rects = [
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 2, y: 2, width: 1, height: 1 }
    ];
    const ann = buildPdfAnnotation({ ...base, type: 'highlight', rect: rects });
    expect(ann.rects).toHaveLength(2);
  });

  it('assigns opacity by type', () => {
    const highlight = buildPdfAnnotation({
      ...base,
      type: 'highlight',
      rect: { x: 0, y: 0, width: 1, height: 1 }
    });
    const comment = buildPdfAnnotation({
      ...base,
      type: 'comment',
      rect: { x: 0, y: 0, width: 1, height: 1 }
    });
    const ink = buildPdfAnnotation({
      ...base,
      type: 'ink',
      rect: { x: 0, y: 0, width: 1, height: 1 }
    });
    expect(highlight.opacity).toBe(0.32);
    expect(comment.opacity).toBe(0.18);
    expect(ink.opacity).toBe(1);
  });

  it('stamps created/updated timestamps and copies extras', () => {
    const ann = buildPdfAnnotation({
      ...base,
      type: 'ink',
      rect: { x: 0, y: 0, width: 1, height: 1 },
      extras: { strokes: [] }
    });
    expect(ann.createdAt).toBe(base.now);
    expect(ann.updatedAt).toBe(base.now);
    expect(ann.strokes).toEqual([]);
  });
});

describe('isCommentLikeAnnotation', () => {
  const make = (type: PdfAnnotation['type'], body?: string): PdfAnnotation =>
    ({
      id: 'x',
      type,
      pageIndex: 0,
      rects: [],
      color: '#000',
      opacity: 1,
      authorId: 'me',
      createdAt: 'now',
      updatedAt: 'now',
      body
    }) as PdfAnnotation;

  it('treats every comment as comment-like', () => {
    expect(isCommentLikeAnnotation(make('comment'))).toBe(true);
  });

  it('treats a highlight with a body as comment-like', () => {
    expect(isCommentLikeAnnotation(make('highlight', 'note text'))).toBe(true);
    expect(isCommentLikeAnnotation(make('highlight', ''))).toBe(true);
  });

  it('treats a plain bodyless highlight as not comment-like', () => {
    expect(isCommentLikeAnnotation(make('highlight'))).toBe(false);
  });

  it('treats ink as not comment-like', () => {
    expect(isCommentLikeAnnotation(make('ink'))).toBe(false);
  });
});

describe('annotationIdAtPoint', () => {
  function layerWith(
    nodes: Array<{
      id: string;
      left: number;
      top: number;
      width: number;
      height: number;
    }>
  ): HTMLElement {
    const layer = document.createElement('div');
    for (const spec of nodes) {
      const node = document.createElement('div');
      node.className = 'pdf-app-annotation';
      node.dataset.annotationId = spec.id;
      node.getBoundingClientRect = () =>
        ({
          left: spec.left,
          top: spec.top,
          right: spec.left + spec.width,
          bottom: spec.top + spec.height,
          width: spec.width,
          height: spec.height,
          x: spec.left,
          y: spec.top,
          toJSON: () => ({})
        }) as DOMRect;
      layer.append(node);
    }
    return layer;
  }

  it('returns null when nothing is under the point', () => {
    const layer = layerWith([
      { id: 'a', left: 0, top: 0, width: 10, height: 10 }
    ]);
    expect(annotationIdAtPoint(layer, 50, 50)).toBeNull();
  });

  it('finds the annotation whose rect contains the point', () => {
    const layer = layerWith([
      { id: 'a', left: 0, top: 0, width: 10, height: 10 },
      { id: 'b', left: 20, top: 20, width: 10, height: 10 }
    ]);
    expect(annotationIdAtPoint(layer, 25, 25)).toBe('b');
    expect(annotationIdAtPoint(layer, 5, 5)).toBe('a');
  });

  it('prefers the topmost (last-rendered) annotation when rects overlap', () => {
    const layer = layerWith([
      { id: 'below', left: 0, top: 0, width: 20, height: 20 },
      { id: 'above', left: 5, top: 5, width: 20, height: 20 }
    ]);
    expect(annotationIdAtPoint(layer, 10, 10)).toBe('above');
  });

  it('keeps the previous hit when a later node has no annotation id', () => {
    const layer = document.createElement('div');

    const below = document.createElement('div');
    below.className = 'pdf-app-annotation';
    below.dataset.annotationId = 'kept';
    below.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 20,
        bottom: 20,
        width: 20,
        height: 20,
        x: 0,
        y: 0,
        toJSON: () => ({})
      }) as DOMRect;

    const above = document.createElement('div');
    above.className = 'pdf-app-annotation';
    above.getBoundingClientRect = () =>
      ({
        left: 5,
        top: 5,
        right: 25,
        bottom: 25,
        width: 20,
        height: 20,
        x: 5,
        y: 5,
        toJSON: () => ({})
      }) as DOMRect;

    layer.append(below, above);

    expect(annotationIdAtPoint(layer, 10, 10)).toBe('kept');
  });

  it('treats rect edges as inside', () => {
    const layer = layerWith([
      { id: 'a', left: 10, top: 10, width: 10, height: 10 }
    ]);
    expect(annotationIdAtPoint(layer, 10, 10)).toBe('a');
    expect(annotationIdAtPoint(layer, 20, 20)).toBe('a');
  });
});
