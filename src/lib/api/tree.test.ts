import { describe, expect, it } from 'vitest';
import { composeTree } from './tree';
import type { Collection } from './collections';
import type { NoteSummary } from './notes';

const collection = (id: string, parent: string | null, name: string): Collection => ({
  id,
  parent_collection_id: parent,
  name,
  position: 0,
  created: '2024-01-01T00:00:00Z',
  modified: '2024-01-01T00:00:00Z'
});

const note = (id: string, parent: string | null, title: string): NoteSummary => ({
  id,
  parent_collection_id: parent,
  title,
  position: 0,
  created: '2024-01-01T00:00:00Z',
  modified: '2024-01-01T00:00:00Z',
  tags: [],
  trashed: false
});

describe('composeTree', () => {
  it('plugs nested folders + notes into the right parents', () => {
    const collections = [
      collection('c1', null, 'Work'),
      collection('c2', 'c1', 'Subwork'),
      collection('c3', null, 'Personal')
    ];
    const notes = [
      note('n1', null, 'root note'),
      note('n2', 'c1', 'work note'),
      note('n3', 'c2', 'subwork note')
    ];
    const result = composeTree(collections, notes);

    // Two top-level folders + one root note.
    expect(result.tree).toHaveLength(3);
    const root = result.tree.find((n) => n.kind === 'note');
    expect(root?.id).toBe('n1');
    const work = result.tree.find((n) => n.kind === 'folder' && n.id === 'c1');
    expect(work?.kind).toBe('folder');
    expect((work as { children: unknown[] }).children).toHaveLength(2); // subwork folder + work note
  });

  it('surfaces dangling-parent folders at root rather than dropping them', () => {
    const collections = [collection('c1', 'missing-parent', 'Orphan')];
    const result = composeTree(collections, []);
    expect(result.tree).toHaveLength(1);
    expect(result.tree[0].id).toBe('c1');
  });

  it('builds notesById and collectionsById maps', () => {
    const collections = [collection('c1', null, 'Work')];
    const notes = [note('n1', 'c1', 'A')];
    const result = composeTree(collections, notes);
    expect(result.notesById['n1']?.title).toBe('A');
    expect(result.collectionsById['c1']?.name).toBe('Work');
  });
});
