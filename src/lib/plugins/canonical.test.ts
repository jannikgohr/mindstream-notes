import { describe, expect, it } from 'vitest';
import { canonicalizeManifest, checksumManifest } from './canonical';

describe('canonicalizeManifest', () => {
  it('is independent of object key order', () => {
    const a = { id: 'x', name: 'A', contributes: { b: 1, a: 2 } };
    const b = { contributes: { a: 2, b: 1 }, name: 'A', id: 'x' };
    expect(canonicalizeManifest(a)).toBe(canonicalizeManifest(b));
  });

  it('preserves array order (order is semantically meaningful)', () => {
    const a = { list: [{ id: 'one' }, { id: 'two' }] };
    const b = { list: [{ id: 'two' }, { id: 'one' }] };
    expect(canonicalizeManifest(a)).not.toBe(canonicalizeManifest(b));
  });

  it('drops undefined values', () => {
    expect(canonicalizeManifest({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('checksumManifest', () => {
  it('is stable across runs and key order', () => {
    const m = { id: 'x', permissions: ['a', 'b'], version: '1.0.0' };
    const reordered = { version: '1.0.0', id: 'x', permissions: ['a', 'b'] };
    expect(checksumManifest(m)).toBe(checksumManifest(reordered));
  });

  it('changes when a contribution changes', () => {
    const before = checksumManifest({ title: 'Meeting — {{date}}' });
    const after = checksumManifest({ title: 'Standup — {{date}}' });
    expect(before).not.toBe(after);
  });

  it('returns an 8-char hex string', () => {
    expect(checksumManifest({ any: 'thing' })).toMatch(/^[0-9a-f]{8}$/);
  });
});
