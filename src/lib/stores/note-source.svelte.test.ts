import { describe, expect, it } from 'vitest';
import { TRASH_ID } from '$lib/api';
import type { Collection, NoteSummary, TreeNode } from '$lib/api';
import {
  childrenOf,
  collectionIsSharedOrUnderShared,
  collectionIsSharedRoot,
  collectionIsUnder,
  collectionIsUnderTrash,
  noteIsUnderShared,
  noteIsUnderTrash,
  nodesForDesktopSource
} from './note-source.svelte';

type SharedMeta = {
  shared?: boolean;
  is_shared?: boolean;
  shared_role?: string | null;
  share_id?: string | null;
};

const collection = (
  id: string,
  parent: string | null = null,
  meta: SharedMeta = {}
): Collection =>
  ({
    id,
    parent_collection_id: parent,
    name: id,
    position: 0,
    created: '2024-01-01T00:00:00Z',
    modified: '2024-01-01T00:00:00Z',
    ...meta
  }) as Collection;

const note = (
  id: string,
  parent: string | null,
  extra: Partial<NoteSummary> = {}
): NoteSummary => ({
  id,
  parent_collection_id: parent,
  title: id,
  position: 0,
  created: '2024-01-01T00:00:00Z',
  modified: '2024-01-01T00:00:00Z',
  tags: [],
  trashed: false,
  favourite: false,
  pushed: false,
  note_kind: 'markdown',
  ...extra
});

const folderNode = (
  id: string,
  children: TreeNode[] = [],
  parent: string | null = null
): TreeNode => ({
  kind: 'folder',
  id,
  name: id,
  position: 0,
  parent_collection_id: parent,
  children
});

const noteNode = (id: string, parent: string | null = null): TreeNode => ({
  kind: 'note',
  id,
  name: id,
  position: 0,
  parent_collection_id: parent
});

const byId = (cols: Collection[]): Record<string, Collection> =>
  Object.fromEntries(cols.map((c) => [c.id, c]));

describe('childrenOf', () => {
  it('returns the roots when folderId is null', () => {
    const roots = [folderNode('a'), noteNode('n')];
    expect(childrenOf(null, roots)).toBe(roots);
  });

  it('finds a nested folder and returns its children', () => {
    const leaf = noteNode('leaf');
    const roots = [folderNode('a', [folderNode('b', [leaf])])];
    expect(childrenOf('b', roots)).toEqual([leaf]);
  });

  it('returns an empty array when the folder is absent', () => {
    expect(childrenOf('missing', [folderNode('a')])).toEqual([]);
  });
});

describe('collectionIsUnder', () => {
  const cols = byId([
    collection('root'),
    collection('child', 'root'),
    collection('grandchild', 'child')
  ]);

  it('returns true for a direct or transitive ancestor', () => {
    expect(collectionIsUnder('child', 'root', cols)).toBe(true);
    expect(collectionIsUnder('grandchild', 'root', cols)).toBe(true);
  });

  it('returns true when the id equals the ancestor', () => {
    expect(collectionIsUnder('root', 'root', cols)).toBe(true);
  });

  it('returns false for an unrelated collection or null', () => {
    expect(collectionIsUnder('root', 'child', cols)).toBe(false);
    expect(collectionIsUnder(null, 'root', cols)).toBe(false);
  });

  it('terminates on a cycle instead of looping forever', () => {
    const cyclic = byId([collection('a', 'b'), collection('b', 'a')]);
    expect(collectionIsUnder('a', 'missing', cyclic)).toBe(false);
  });
});

describe('trash membership', () => {
  const cols = byId([
    collection(TRASH_ID),
    collection('deleted', TRASH_ID),
    collection('alive')
  ]);

  it('collectionIsUnderTrash follows the chain to the trash root', () => {
    expect(collectionIsUnderTrash('deleted', cols)).toBe(true);
    expect(collectionIsUnderTrash('alive', cols)).toBe(false);
  });

  it('noteIsUnderTrash is true when the note is soft-deleted', () => {
    expect(noteIsUnderTrash(note('n', 'alive', { trashed: true }), cols)).toBe(
      true
    );
  });

  it('noteIsUnderTrash is true when the note lives under trash', () => {
    expect(noteIsUnderTrash(note('n', 'deleted'), cols)).toBe(true);
  });

  it('noteIsUnderTrash is false for a live note in a live folder', () => {
    expect(noteIsUnderTrash(note('n', 'alive'), cols)).toBe(false);
  });
});

describe('shared detection', () => {
  it('recognises a top-level shared collection as a shared root', () => {
    const shared = collection('s', null, { shared: true });
    const cols = byId([shared]);
    expect(collectionIsSharedRoot(shared, cols)).toBe(true);
  });

  it('does not treat a nested shared collection as a shared root', () => {
    const root = collection('root', null, { is_shared: true });
    const nested = collection('nested', 'root', { shared: true });
    const cols = byId([root, nested]);
    expect(collectionIsSharedRoot(nested, cols)).toBe(false);
  });

  it('detects sharing via any of the metadata flags', () => {
    for (const meta of [
      { shared: true },
      { is_shared: true },
      { shared_role: 'editor' },
      { share_id: 'abc' }
    ]) {
      const c = collection('s', null, meta);
      expect(collectionIsSharedRoot(c, byId([c]))).toBe(true);
    }
  });

  it('collectionIsSharedOrUnderShared walks ancestors', () => {
    const root = collection('root', null, { shared: true });
    const child = collection('child', 'root');
    const cols = byId([root, child]);
    expect(collectionIsSharedOrUnderShared('child', cols)).toBe(true);
    expect(collectionIsSharedOrUnderShared(null, cols)).toBe(false);
  });

  it('noteIsUnderShared reflects the note parent chain', () => {
    const root = collection('root', null, { shared: true });
    const cols = byId([root]);
    expect(noteIsUnderShared(note('n', 'root'), cols)).toBe(true);
    expect(noteIsUnderShared(note('n', null), cols)).toBe(false);
  });
});

describe('nodesForDesktopSource', () => {
  it('favourites lists favourite notes that are not trashed', () => {
    const cols = byId([collection(TRASH_ID), collection('deleted', TRASH_ID)]);
    const notesById = {
      a: note('a', null, { favourite: true }),
      b: note('b', null, { favourite: false }),
      c: note('c', 'deleted', { favourite: true })
    };
    const out = nodesForDesktopSource('favourites', [], notesById, cols);
    expect(out.map((n) => n.id)).toEqual(['a']);
  });

  it('home hides the trash folder and trashed notes', () => {
    const cols = byId([collection(TRASH_ID)]);
    const tree = [noteNode('keep'), noteNode('gone'), folderNode(TRASH_ID)];
    const notesById = {
      keep: note('keep', null),
      gone: note('gone', null, { trashed: true })
    };
    const out = nodesForDesktopSource('home', tree, notesById, cols);
    expect(out.map((n) => n.id)).toEqual(['keep']);
  });

  it('shared returns only shared root folders', () => {
    const cols = byId([
      collection('shared', null, { shared: true }),
      collection('personal')
    ]);
    const tree = [folderNode('shared'), folderNode('personal')];
    const out = nodesForDesktopSource('shared', tree, {}, cols);
    expect(out.map((n) => n.id)).toEqual(['shared']);
  });

  it('trash surfaces folders under trash plus soft-deleted notes', () => {
    const cols = byId([
      collection(TRASH_ID),
      collection('deletedFolder', TRASH_ID)
    ]);
    const tree = [folderNode(TRASH_ID, [folderNode('deletedFolder')])];
    const notesById = {
      orphan: note('orphan', null, { trashed: true })
    };
    const out = nodesForDesktopSource('trash', tree, notesById, cols);
    const ids = out.map((n) => n.id);
    expect(ids).toContain('deletedFolder');
    expect(ids).toContain('orphan');
  });
});
