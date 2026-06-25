import { describe, expect, it } from 'vitest';
import { sanitizePdfFilename } from './filename';

describe('sanitizePdfFilename', () => {
  it('strips Windows-illegal characters', () => {
    expect(sanitizePdfFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij');
  });

  it('collapses whitespace and trims', () => {
    expect(sanitizePdfFilename('  my   note  ')).toBe('my note');
  });

  it('keeps spaces and unicode', () => {
    expect(sanitizePdfFilename('Café résumé 笔记')).toBe('Café résumé 笔记');
  });

  it('caps the length at 120 characters', () => {
    expect(sanitizePdfFilename('x'.repeat(200))).toHaveLength(120);
  });

  it('falls back to a default when empty after cleaning', () => {
    expect(sanitizePdfFilename('   ')).toBe('pdf-note');
    expect(sanitizePdfFilename('/:*?')).toBe('pdf-note');
  });
});
