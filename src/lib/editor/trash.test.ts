import { describe, expect, it } from 'vitest';
import { ancestorIsTrash } from './trash';
describe('ancestorIsTrash', () => {
  it('recognizes deeply nested trash', () => {
    expect(
      ancestorIsTrash('child', {
        child: { parent_collection_id: 'parent' },
        parent: { parent_collection_id: 'trash' }
      })
    ).toBe(true);
  });
  it('stops at roots, missing parents, and cycles', () => {
    expect(ancestorIsTrash(null, {})).toBe(false);
    expect(ancestorIsTrash('missing', {})).toBe(false);
    expect(
      ancestorIsTrash('a', {
        a: { parent_collection_id: 'b' },
        b: { parent_collection_id: 'a' }
      })
    ).toBe(false);
  });
});
