import { describe, expect, it } from 'vitest';

import type { Collection } from '$lib/api';
import { TRASH_ID } from '$lib/api';
import {
  folderOptions,
  sourceKindLabelKey,
  uniqueFolderName
} from './import-notes-helpers';

function collection(
  id: string,
  name: string,
  parent: string | null = null
): Collection {
  return {
    id,
    name,
    parent_collection_id: parent,
    position: 0,
    created: '2026-01-01T00:00:00Z',
    modified: '2026-01-01T00:00:00Z',
    trashed: false,
    pushed: false
  } as unknown as Collection;
}

function byId(...items: Collection[]): Record<string, Collection> {
  return Object.fromEntries(items.map((c) => [c.id, c]));
}

describe('folderOptions', () => {
  it('flattens the tree depth-first with nesting levels', () => {
    const tree = byId(
      collection('work', 'Work'),
      collection('sprint', 'Sprint', 'work'),
      collection('personal', 'Personal')
    );

    expect(folderOptions(tree)).toEqual([
      { id: 'personal', name: 'Personal', depth: 0 },
      { id: 'work', name: 'Work', depth: 0 },
      { id: 'sprint', name: 'Sprint', depth: 1 }
    ]);
  });

  it('excludes trash and everything under it', () => {
    // Importing into the trash would file a fresh vault as already deleted.
    const tree = byId(
      collection(TRASH_ID, 'Trash'),
      collection('deleted', 'Old project', TRASH_ID),
      collection('keep', 'Keep')
    );

    expect(folderOptions(tree).map((f) => f.id)).toEqual(['keep']);
  });

  it('sorts siblings by name so the list is stable', () => {
    const tree = byId(
      collection('b', 'Beta'),
      collection('a', 'Alpha'),
      collection('c', 'Gamma')
    );

    expect(folderOptions(tree).map((f) => f.name)).toEqual([
      'Alpha',
      'Beta',
      'Gamma'
    ]);
  });

  it('returns an empty list for an empty vault', () => {
    expect(folderOptions({})).toEqual([]);
  });
});

describe('uniqueFolderName', () => {
  it('keeps the suggested name when nothing collides', () => {
    expect(
      uniqueFolderName('My vault', byId(collection('a', 'Work')), null)
    ).toBe('My vault');
  });

  it('suffixes on collision, so a repeat import stays readable', () => {
    const tree = byId(
      collection('a', 'My vault'),
      collection('b', 'My vault 2')
    );
    expect(uniqueFolderName('My vault', tree, null)).toBe('My vault 3');
  });

  it('compares case-insensitively', () => {
    expect(
      uniqueFolderName('my vault', byId(collection('a', 'My Vault')), null)
    ).toBe('my vault 2');
  });

  it('only considers siblings of the chosen destination', () => {
    // A folder called "Notes" elsewhere in the tree is not a collision.
    const tree = byId(
      collection('parent', 'Parent'),
      collection('elsewhere', 'Notes')
    );
    expect(uniqueFolderName('Notes', tree, 'parent')).toBe('Notes');
  });

  it('falls back to a usable name when the source suggested nothing', () => {
    expect(uniqueFolderName('   ', {}, null)).toBe('Imported notes');
  });
});

describe('sourceKindLabelKey', () => {
  it('namespaces under the import dialog block', () => {
    expect(sourceKindLabelKey('joplin-jex')).toBe(
      'data.importNotes.kind.joplin-jex'
    );
  });
});
