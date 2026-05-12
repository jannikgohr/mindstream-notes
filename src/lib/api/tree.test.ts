import { describe, expect, it } from 'vitest';
import { composeTree } from './tree';
import { TRASH_ID } from './index';
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

const note = (
  id: string,
  parent: string | null,
  title: string,
  trashed = false
): NoteSummary => ({
  id,
  parent_collection_id: parent,
  title,
  position: 0,
  created: '2024-01-01T00:00:00Z',
  modified: '2024-01-01T00:00:00Z',
  tags: [],
  trashed,
  favourite: false,
  pushed: false
});

describe('composeTree', () => {
  it('plugs nested folders + notes into the right parents', () => {
    const collections = [
      collection('c1', null, 'Work'),
      collection('c2', 'c1', 'Subwork'),
      collection('c3', null, 'Personal'),
      collection(TRASH_ID, null, 'Trash')
    ];
    const notes = [
      note('n1', null, 'root note'),
      note('n2', 'c1', 'work note'),
      note('n3', 'c2', 'subwork note')
    ];
    const result = composeTree(collections, notes);

    // 3 top-level folders (Work + Personal + Trash) + 1 root note.
    expect(result.tree).toHaveLength(4);
    const root = result.tree.find((n) => n.kind === 'note');
    expect(root?.id).toBe('n1');
    const work = result.tree.find((n) => n.kind === 'folder' && n.id === 'c1');
    expect((work as { children: unknown[] }).children).toHaveLength(2);
  });

  it('surfaces dangling-parent folders at root rather than dropping them', () => {
    const collections = [collection('c1', 'missing-parent', 'Orphan')];
    const result = composeTree(collections, []);
    // Orphan + auto-added trash.
    expect(result.tree).toHaveLength(2);
    expect(result.tree.some((n) => n.id === 'c1')).toBe(true);
  });

  it('builds notesById and collectionsById maps', () => {
    const collections = [collection('c1', null, 'Work')];
    const notes = [note('n1', 'c1', 'A')];
    const result = composeTree(collections, notes);
    expect(result.notesById['n1']?.title).toBe('A');
    expect(result.collectionsById['c1']?.name).toBe('Work');
  });

  it('always includes the trash folder even when the DB is missing it', () => {
    const result = composeTree([], []);
    expect(result.tree.find((n) => n.id === TRASH_ID)).toBeDefined();
    expect(result.tree.find((n) => n.id === TRASH_ID)?.kind).toBe('folder');
  });

  it('attaches trashed notes underneath the trash folder', () => {
    const collections = [collection(TRASH_ID, null, 'Trash')];
    const notes = [note('n1', TRASH_ID, 'goodbye', true)];
    const result = composeTree(collections, notes);
    const trash = result.tree.find((n) => n.id === TRASH_ID);
    expect(trash?.kind).toBe('folder');
    if (trash?.kind !== 'folder') return; // narrow
    expect(trash.children).toHaveLength(1);
    expect(trash.children[0].id).toBe('n1');
  });
});
