import { describe, expect, it } from 'vitest';
import { annotationCanMove } from './annotation-interaction';

describe('annotationCanMove', () => {
  it('lets the Signature tool move an existing signature', () => {
    expect(annotationCanMove('signature', 'signature', false)).toBe(true);
  });

  it('does not make ink movable while drawing', () => {
    expect(annotationCanMove('ink', 'pen', false)).toBe(false);
  });

  it('keeps ink and signatures movable in text modes', () => {
    expect(annotationCanMove('ink', 'select', true)).toBe(true);
    expect(annotationCanMove('signature', 'select', true)).toBe(true);
  });
});
