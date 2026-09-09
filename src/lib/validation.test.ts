import { describe, expect, it } from 'vitest';
import { assertRequiredString, isRecord } from './validation';
describe('shared validation', () => {
  it('distinguishes object records from primitives and arrays', () => {
    expect(isRecord({ name: 'note' })).toBe(true);
    for (const value of [null, undefined, 'text', 0, [], true])
      expect(isRecord(value)).toBe(false);
  });
  it('rejects whitespace-only strings with field context', () => {
    expect(() => assertRequiredString('  ', 'note id')).toThrow(
      'note id must be a non-empty string'
    );
    expect(() => assertRequiredString('n', 'note id')).not.toThrow();
  });
});
