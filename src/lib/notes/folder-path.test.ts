import { describe, expect, it } from 'vitest';
import { folderPath, folderPathLabel } from './folder-path';
import { TRASH_ID } from '$lib/api';
import type { Collection } from '$lib/api';

const col = (id: string, parent: string | null, name = id): Collection => ({
  id,
  parent_collection_id: parent,
  name,
  position: 0,
  created: '2024-01-01',
  modified: '2024-01-01'
});

const byId = (cols: Collection[]): Record<string, Collection> =>
  Object.fromEntries(cols.map((c) => [c.id, c]));

describe('folderPath', () => {
  it('returns an empty path for a null parent', () => {
    expect(folderPath(null, {})).toEqual([]);
  });

  it('resolves the chain root-first', () => {
    const cols = byId([col('a', null), col('b', 'a'), col('c', 'b')]);
    expect(folderPath('c', cols).map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('stops at the first unknown ancestor', () => {
    const cols = byId([col('b', 'missing')]);
    expect(folderPath('b', cols).map((c) => c.id)).toEqual(['b']);
  });

  it('terminates on a cycle', () => {
    const cols = byId([col('a', 'b'), col('b', 'a')]);
    // Whichever order, it must not loop forever and returns both once.
    expect(folderPath('a', cols)).toHaveLength(2);
  });
});

describe('folderPathLabel', () => {
  it('joins names with a slash', () => {
    const cols = byId([col('a', null, 'Work'), col('b', 'a', 'Q1')]);
    expect(folderPathLabel('b', cols)).toBe('Work / Q1');
  });

  it('returns an empty string for a root note', () => {
    expect(folderPathLabel(null, {})).toBe('');
  });

  it('hides the trash root from the label', () => {
    const cols = byId([
      col(TRASH_ID, null, 'Trash'),
      col('deleted', TRASH_ID, 'Deleted folder')
    ]);
    expect(folderPathLabel('deleted', cols)).toBe('Deleted folder');
  });
});
