import { describe, expect, it } from 'vitest';
import { TRASH_ID } from '$lib/api';
import type { Collection, NoteSummary, TreeItemRef, TreeNode } from '$lib/api';
import {
  childrenOf,
  collectionIsSharedOrUnderShared,
  collectionIsSharedRoot,
  collectionIsSharedWithMe,
  collectionIsUnder,
  collectionIsUnderTrash,
  collectionScopeIsReadOnly,
  collectionUserCanManageSharing,
  itemSharedRootId,
  noteIsUnderShared,
  noteIsUnderTrash,
  nodesForDesktopSource,
  sharedFolderIsEditable,
  sharedMoveIsLegal,
  sharedRootIdFor
} from './note-source.svelte';

type SharedMeta = {
  shared?: boolean;
  is_shared?: boolean;
  shared_role?: string | null;
  share_id?: string | null;
  shared_by_me?: boolean;
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

  it('does not treat collections shared by me as shared-with-me roots', () => {
    const c = collection('mine', null, {
      share_id: 'remote-coll',
      shared_by_me: true
    });
    expect(collectionIsSharedWithMe(c)).toBe(false);
    expect(collectionIsSharedRoot(c, byId([c]))).toBe(false);
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

describe('collectionUserCanManageSharing', () => {
  it('allows owners and admin recipients to manage sharing', () => {
    expect(
      collectionUserCanManageSharing(
        collection('mine', null, { shared_by_me: true })
      )
    ).toBe(true);
    expect(
      collectionUserCanManageSharing(
        collection('admin', null, { shared_role: 'admin' })
      )
    ).toBe(true);
  });

  it('rejects read-only, read-write, and personal folders', () => {
    expect(
      collectionUserCanManageSharing(
        collection('reader', null, { shared_role: 'read_only' })
      )
    ).toBe(false);
    expect(
      collectionUserCanManageSharing(
        collection('writer', null, { shared_role: 'read_write' })
      )
    ).toBe(false);
    expect(collectionUserCanManageSharing(collection('personal'))).toBe(false);
  });
});

describe('collectionScopeIsReadOnly', () => {
  it('is true for a note under a read-only shared root', () => {
    const root = collection('root', null, { shared_role: 'read_only' });
    const child = collection('child', 'root');
    const cols = byId([root, child]);
    expect(collectionScopeIsReadOnly('child', cols)).toBe(true);
    expect(collectionScopeIsReadOnly('root', cols)).toBe(true);
  });

  it('is false when the nearest shared root grants write access', () => {
    const root = collection('root', null, { shared_role: 'read_write' });
    const child = collection('child', 'root');
    const cols = byId([root, child]);
    expect(collectionScopeIsReadOnly('child', cols)).toBe(false);
  });

  it('ignores a folder shared by me even if it is read_only downstream', () => {
    const mine = collection('mine', null, {
      share_id: 'remote-coll',
      shared_by_me: true,
      shared_role: 'read_only'
    });
    const cols = byId([mine]);
    expect(collectionScopeIsReadOnly('mine', cols)).toBe(false);
  });

  it('is false for a personal note and for null', () => {
    const cols = byId([collection('personal')]);
    expect(collectionScopeIsReadOnly('personal', cols)).toBe(false);
    expect(collectionScopeIsReadOnly(null, cols)).toBe(false);
  });

  it('terminates on a cycle instead of looping forever', () => {
    const cyclic = byId([collection('a', 'b'), collection('b', 'a')]);
    expect(collectionScopeIsReadOnly('a', cyclic)).toBe(false);
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
      collection('shared', null, { shared_role: 'read_write' }),
      collection('sharedByMe', null, {
        share_id: 'remote-coll',
        shared_by_me: true
      }),
      collection('personal')
    ]);
    const tree = [
      folderNode('shared'),
      folderNode('sharedByMe'),
      folderNode('personal')
    ];
    const out = nodesForDesktopSource('shared', tree, {}, cols);
    expect(out.map((n) => n.id)).toEqual(['shared']);
  });

  it('shared finds a shared root nested under a personal folder', () => {
    const cols = byId([
      collection('parent'),
      collection('sharedChild', 'parent', { shared_role: 'read_write' })
    ]);
    const tree = [
      folderNode('parent', [folderNode('sharedChild', [], 'parent')])
    ];
    const out = nodesForDesktopSource('shared', tree, {}, cols);
    expect(out.map((n) => n.id)).toEqual(['sharedChild']);
  });

  it('shared excludes a shared root that lives under trash', () => {
    const cols = byId([
      collection(TRASH_ID),
      collection('sharedDeleted', TRASH_ID, { shared_role: 'read_write' })
    ]);
    const tree = [
      folderNode(TRASH_ID, [folderNode('sharedDeleted', [], TRASH_ID)])
    ];
    const out = nodesForDesktopSource('shared', tree, {}, cols);
    expect(out.map((n) => n.id)).toEqual([]);
  });

  it('home hides shared-with-me roots but keeps personal and shared-by-me folders', () => {
    const cols = byId([
      collection('sharedWithMe', null, { shared_role: 'read_write' }),
      collection('mine', null, { share_id: 'remote-coll', shared_by_me: true }),
      collection('personal')
    ]);
    const tree = [
      folderNode('sharedWithMe'),
      folderNode('mine'),
      folderNode('personal')
    ];
    const out = nodesForDesktopSource('home', tree, {}, cols);
    expect(out.map((n) => n.id)).toEqual(['mine', 'personal']);
  });

  it('home prunes a shared root nested inside a personal folder', () => {
    const cols = byId([
      collection('parent'),
      collection('sharedChild', 'parent', { shared_role: 'read_write' }),
      collection('plainChild', 'parent')
    ]);
    const tree = [
      folderNode('parent', [
        folderNode('sharedChild', [], 'parent'),
        folderNode('plainChild', [], 'parent')
      ])
    ];
    const out = nodesForDesktopSource('home', tree, {}, cols);
    expect(out.map((n) => n.id)).toEqual(['parent']);
    const parent = out[0];
    const childIds =
      parent.kind === 'folder' ? parent.children.map((c) => c.id) : [];
    expect(childIds).toEqual(['plainChild']);
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

describe('sharedRootIdFor', () => {
  const cols = byId([
    collection('root', null, { shared_role: 'read_write' }),
    collection('child', 'root'),
    collection('grandchild', 'child'),
    collection('personal'),
    collection('mine', null, { share_id: 'remote', shared_by_me: true })
  ]);

  it('returns the shared root id for a nested descendant', () => {
    expect(sharedRootIdFor('grandchild', cols)).toBe('root');
    expect(sharedRootIdFor('child', cols)).toBe('root');
  });

  it('returns the root itself when it is the shared anchor', () => {
    expect(sharedRootIdFor('root', cols)).toBe('root');
  });

  it('returns null for personal folders and for null / shared-by-me', () => {
    expect(sharedRootIdFor('personal', cols)).toBe(null);
    expect(sharedRootIdFor(null, cols)).toBe(null);
    expect(sharedRootIdFor('mine', cols)).toBe(null);
  });

  it('terminates on a cycle instead of looping forever', () => {
    const cyclic = byId([collection('a', 'b'), collection('b', 'a')]);
    expect(sharedRootIdFor('a', cyclic)).toBe(null);
  });
});

describe('itemSharedRootId', () => {
  const cols = byId([
    collection('root', null, { shared_role: 'read_write' }),
    collection('child', 'root')
  ]);
  const notesById = {
    n1: note('n1', 'child'),
    n2: note('n2', null)
  };

  it('resolves a note through its parent folder', () => {
    expect(itemSharedRootId({ kind: 'note', id: 'n1' }, notesById, cols)).toBe(
      'root'
    );
    expect(itemSharedRootId({ kind: 'note', id: 'n2' }, notesById, cols)).toBe(
      null
    );
  });

  it('resolves a folder through itself', () => {
    expect(
      itemSharedRootId({ kind: 'folder', id: 'child' }, notesById, cols)
    ).toBe('root');
  });

  it('returns null for a missing note', () => {
    expect(
      itemSharedRootId({ kind: 'note', id: 'ghost' }, notesById, cols)
    ).toBe(null);
  });
});

describe('sharedFolderIsEditable', () => {
  const cols = byId([
    collection('rw', null, { shared_role: 'read_write' }),
    collection('rwChild', 'rw'),
    collection('admin', null, { shared_role: 'admin' }),
    collection('ro', null, { shared_role: 'read_only' }),
    collection('roChild', 'ro'),
    collection('personal')
  ]);

  it('is true inside read_write and admin scopes', () => {
    expect(sharedFolderIsEditable('rw', cols)).toBe(true);
    expect(sharedFolderIsEditable('rwChild', cols)).toBe(true);
    expect(sharedFolderIsEditable('admin', cols)).toBe(true);
  });

  it('is false inside read_only scopes', () => {
    expect(sharedFolderIsEditable('ro', cols)).toBe(false);
    expect(sharedFolderIsEditable('roChild', cols)).toBe(false);
  });

  it('is false for personal folders and null', () => {
    expect(sharedFolderIsEditable('personal', cols)).toBe(false);
    expect(sharedFolderIsEditable(null, cols)).toBe(false);
  });
});

describe('sharedMoveIsLegal', () => {
  // Two independent shared scopes plus a read-only one, each with a subfolder.
  const cols = byId([
    collection('a', null, { shared_role: 'read_write' }),
    collection('aSub', 'a'),
    collection('aDeep', 'aSub'),
    collection('b', null, { shared_role: 'admin' }),
    collection('bSub', 'b'),
    collection('ro', null, { shared_role: 'read_only' }),
    collection('roSub', 'ro'),
    collection('personal')
  ]);
  const notesById = {
    aNote: note('aNote', 'a'),
    aSubNote: note('aSubNote', 'aSub'),
    bNote: note('bNote', 'b')
  };
  const move = (items: TreeItemRef[], target: string | null) =>
    sharedMoveIsLegal(items, target, notesById, cols);

  it('allows an intra-scope move into an editable folder', () => {
    expect(move([{ kind: 'note', id: 'aNote' }], 'aSub')).toBe(true);
    expect(
      move(
        [
          { kind: 'note', id: 'aNote' },
          { kind: 'folder', id: 'aSub' }
        ],
        'a'
      )
    ).toBe(true);
  });

  it('rejects a cross-scope move', () => {
    expect(move([{ kind: 'note', id: 'aNote' }], 'bSub')).toBe(false);
    expect(move([{ kind: 'folder', id: 'aSub' }], 'b')).toBe(false);
  });

  it('rejects any move into a read-only scope', () => {
    expect(move([{ kind: 'note', id: 'aNote' }], 'roSub')).toBe(false);
  });

  it('rejects a drop onto the shared-view root (target null)', () => {
    expect(move([{ kind: 'note', id: 'aNote' }], null)).toBe(false);
  });

  it('rejects dropping a folder onto itself or a descendant', () => {
    expect(move([{ kind: 'folder', id: 'aSub' }], 'aSub')).toBe(false);
    expect(move([{ kind: 'folder', id: 'aSub' }], 'aDeep')).toBe(false);
  });

  it('blocks the whole batch when one item is in another scope', () => {
    expect(
      move(
        [
          { kind: 'note', id: 'aNote' },
          { kind: 'note', id: 'bNote' }
        ],
        'aSub'
      )
    ).toBe(false);
  });

  it('rejects an empty selection', () => {
    expect(move([], 'aSub')).toBe(false);
  });
});
