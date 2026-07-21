import { describe, expect, it } from 'vitest';
import {
  accessibleCommentText,
  annotationAriaLabel,
  annotationTypeLabel,
  formatPdfUi
} from './annotation-labels';
import type { PdfAnnotation } from './types';

function annotation(patch: Partial<PdfAnnotation> = {}): PdfAnnotation {
  return {
    id: 'a1',
    type: 'highlight',
    pageIndex: 2,
    rects: [{ x: 0, y: 0, width: 10, height: 10 }],
    color: '#ffcc00',
    createdAt: 0,
    updatedAt: 0,
    authorId: 'local',
    ...patch
  } as PdfAnnotation;
}

describe('formatPdfUi', () => {
  it('substitutes every occurrence of a placeholder', () => {
    expect(
      formatPdfUi('pdf.annotation.accessible.part', { part: 2, total: 5 })
    ).toContain('2');
  });
});

describe('annotationTypeLabel', () => {
  it('names each annotation type', () => {
    const labels = (['highlight', 'comment', 'ink', 'signature'] as const).map(
      annotationTypeLabel
    );
    // Every type resolves to a distinct, non-key string.
    expect(new Set(labels).size).toBe(4);
    for (const label of labels) expect(label).not.toContain('pdf.annotation');
  });
});

describe('accessibleCommentText', () => {
  it('is empty when there is no body', () => {
    expect(accessibleCommentText(annotation())).toBe('');
    expect(accessibleCommentText(annotation({ body: '   ' }))).toBe('');
  });

  it('collapses whitespace so a multi-line note reads as one sentence', () => {
    expect(accessibleCommentText(annotation({ body: 'a\n\n  b' }))).toContain(
      'a b'
    );
  });

  it('truncates a long body with an ellipsis', () => {
    const text = accessibleCommentText(annotation({ body: 'x'.repeat(300) }));
    expect(text).toContain('...');
    // 137 kept characters + the ellipsis.
    expect(text).toContain('x'.repeat(137) + '...');
    expect(text).not.toContain('x'.repeat(138));
  });

  it('leaves a body at the limit untouched', () => {
    const body = 'y'.repeat(140);
    expect(accessibleCommentText(annotation({ body }))).toContain(body);
  });
});

describe('annotationAriaLabel', () => {
  it('says select for the select tool and delete for the delete tool', () => {
    const select = annotationAriaLabel(annotation(), 0, 1, null, 'select');
    const remove = annotationAriaLabel(annotation(), 0, 1, null, 'delete');
    expect(select).not.toBe(remove);
  });

  it('names the 1-based page number', () => {
    expect(annotationAriaLabel(annotation(), 0, 1, null, 'select')).toContain(
      '3'
    );
  });

  it('mentions the part only when the annotation spans several rects', () => {
    const single = annotationAriaLabel(annotation(), 0, 1, null, 'select');
    const part = annotationAriaLabel(annotation(), 1, 3, null, 'select');
    expect(part.length).toBeGreaterThan(single.length);
    expect(part).toContain('2');
  });

  it('reports the selected state only for the selected annotation', () => {
    const unselected = annotationAriaLabel(annotation(), 0, 1, null, 'select');
    const selected = annotationAriaLabel(annotation(), 0, 1, 'a1', 'select');
    expect(selected).not.toBe(unselected);
  });

  it('reports resolved when the annotation is resolved and unselected', () => {
    const resolved = annotationAriaLabel(
      annotation({ resolved: true }),
      0,
      1,
      null,
      'select'
    );
    expect(resolved).not.toBe(
      annotationAriaLabel(annotation(), 0, 1, null, 'select')
    );
  });

  it('folds the comment body into the label', () => {
    const label = annotationAriaLabel(
      annotation({ type: 'comment', body: 'ship it' }),
      0,
      1,
      null,
      'select'
    );
    expect(label).toContain('ship it');
  });
});
