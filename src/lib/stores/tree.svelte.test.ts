import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the api module BEFORE importing the store so the import binding picks
// up the mocked version. Vitest's vi.mock is hoisted automatically.
const saveNoteMock = vi.fn();
const updateCollectionMock = vi.fn();
const createNoteMock = vi.fn();
const createCollectionMock = vi.fn();
const importPdfNoteMock = vi.fn();
const trashNoteMock = vi.fn();
const restoreNoteMock = vi.fn();
const purgeNoteMock = vi.fn();
const deleteCollectionMock = vi.fn();
const emptyTrashCmdMock = vi.fn();
const loadTreeMock = vi.fn();
const runSyncMock = vi.fn();

vi.mock('$lib/api', () => ({
  saveNote: (...args: unknown[]) => saveNoteMock(...args),
  updateCollection: (...args: unknown[]) => updateCollectionMock(...args),
  createNote: (...args: unknown[]) => createNoteMock(...args),
  createCollection: (...args: unknown[]) => createCollectionMock(...args),
  importPdfNote: (...args: unknown[]) => importPdfNoteMock(...args),
  trashNote: (...args: unknown[]) => trashNoteMock(...args),
  restoreNote: (...args: unknown[]) => restoreNoteMock(...args),
  purgeNote: (...args: unknown[]) => purgeNoteMock(...args),
  deleteCollection: (...args: unknown[]) => deleteCollectionMock(...args),
  emptyTrashCmd: (...args: unknown[]) => emptyTrashCmdMock(...args),
  loadTree: (...args: unknown[]) => loadTreeMock(...args),
  TRASH_ID: 'trash'
}));

vi.mock('$lib/sync/runner', () => ({
  runSync: (...args: unknown[]) => runSyncMock(...args)
}));

// Avoid pulling state.svelte (which depends on browser localStorage etc.)
vi.mock('$lib/state.svelte', () => ({
  ui: { activeNoteId: null }
}));

// settings/store.svelte transitively imports mode-watcher; stub the surface
// the tree store reads from it instead of trying to resolve the real thing.
vi.mock('$lib/settings/store.svelte', () => ({
  getSettingValue: () => false // useTrash off → trashNote does hard delete
}));

import {
  addNoteTag,
  allTagsInUse,
  createCollectionIn,
  createNoteIn,
  emptyTrash,
  importPdfIn,
  moveCollectionTo,
  moveNoteTo,
  normalizeTagPath,
  purgeCollection,
  purgeNote,
  removeNoteTag,
  renameCollection,
  renameNote,
  restoreCollection,
  restoreNote,
  setNoteBody,
  setNoteFavourite,
  setNoteTags,
  tree,
  trashCollection,
  trashNote
} from './tree.svelte';

import type { NoteSummary } from '$lib/api';

const seedNote = (over: Partial<NoteSummary> = {}): NoteSummary => ({
  id: 'n1',
  parent_collection_id: null,
  title: 'seed',
  position: 0,
  created: '2024-01-01',
  modified: '2024-01-01',
  tags: [],
  trashed: false,
  favourite: false,
  pushed: true,
  note_kind: 'markdown',
  ...over
});

beforeEach(() => {
  saveNoteMock.mockReset().mockResolvedValue(undefined);
  updateCollectionMock.mockReset().mockResolvedValue(undefined);
  createNoteMock.mockReset().mockResolvedValue(undefined);
  trashNoteMock.mockReset().mockResolvedValue(undefined);
  restoreNoteMock.mockReset().mockResolvedValue(undefined);
  purgeNoteMock.mockReset().mockResolvedValue(undefined);
  deleteCollectionMock.mockReset().mockResolvedValue(undefined);
  createCollectionMock.mockReset().mockResolvedValue({ id: 'coll_new' });
  importPdfNoteMock.mockReset().mockResolvedValue({ id: 'note_pdf' });
  emptyTrashCmdMock.mockReset().mockResolvedValue({ notes: 2, folders: 1 });
  runSyncMock.mockReset().mockResolvedValue(undefined);
  createNoteMock.mockResolvedValue({ id: 'note_new', pushed: true });
  loadTreeMock.mockReset().mockResolvedValue({
    tree: [],
    notesById: {},
    collectionsById: {}
  });
  tree.notesById = {};
  tree.collectionsById = {};
  tree.tree = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('moveNoteTo', () => {
  it('passes parent_collection_id=null for "move to root"', async () => {
    await moveNoteTo('note_1', null);
    expect(saveNoteMock).toHaveBeenCalledTimes(1);
    expect(saveNoteMock).toHaveBeenCalledWith({
      id: 'note_1',
      parent_collection_id: null
    });
  });

  it('passes the target collection id otherwise', async () => {
    await moveNoteTo('note_1', 'coll_42');
    expect(saveNoteMock).toHaveBeenCalledWith({
      id: 'note_1',
      parent_collection_id: 'coll_42'
    });
  });
});

describe('moveCollectionTo', () => {
  it('passes parent_collection_id=null for "move to root"', async () => {
    await moveCollectionTo('coll_1', null);
    expect(updateCollectionMock).toHaveBeenCalledWith({
      id: 'coll_1',
      parent_collection_id: null
    });
  });

  it('passes the target collection id otherwise', async () => {
    await moveCollectionTo('coll_1', 'coll_42');
    expect(updateCollectionMock).toHaveBeenCalledWith({
      id: 'coll_1',
      parent_collection_id: 'coll_42'
    });
  });
});

describe('trashNote (useTrash off via mocked setting)', () => {
  it('falls through to api.trashNote', async () => {
    await trashNote('note_x');
    expect(trashNoteMock).toHaveBeenCalledWith('note_x');
  });
});

describe('trash actions', () => {
  it('restoreNote moves the note to root', async () => {
    await restoreNote('note_1');
    expect(saveNoteMock).toHaveBeenCalledWith({
      id: 'note_1',
      parent_collection_id: null
    });
  });

  it('purgeNote calls the api', async () => {
    await purgeNote('note_1');
    expect(purgeNoteMock).toHaveBeenCalledWith('note_1');
  });
});

describe('normalizeTagPath', () => {
  it('trims segments and drops empty ones', () => {
    expect(normalizeTagPath(' work / urgent ')).toBe('work/urgent');
    expect(normalizeTagPath('work//foo')).toBe('work/foo');
    expect(normalizeTagPath('   ')).toBe('');
  });
});

describe('allTagsInUse', () => {
  it('aggregates non-trashed tags, sorted case-insensitively', () => {
    tree.notesById = {
      a: seedNote({ id: 'a', tags: ['Zebra', 'apple'] }),
      b: seedNote({ id: 'b', tags: ['apple', 'mango'] }),
      c: seedNote({ id: 'c', tags: ['hidden'], trashed: true })
    };
    expect(allTagsInUse()).toEqual(['apple', 'mango', 'Zebra']);
  });
});

describe('createNoteIn / importPdfIn', () => {
  it('creates a note and returns its id', async () => {
    const id = await createNoteIn('coll_1', 'Hello', 'markdown');
    expect(createNoteMock).toHaveBeenCalledWith({
      parent_collection_id: 'coll_1',
      title: 'Hello',
      note_kind: 'markdown'
    });
    expect(id).toBe('note_new');
  });

  it('imports a PDF, deriving the title from the filename', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'My Doc.pdf', {
      type: 'application/pdf'
    });
    const id = await importPdfIn(null, file);
    expect(importPdfNoteMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'My Doc' })
    );
    expect(id).toBe('note_pdf');
  });
});

describe('optimistic note patches', () => {
  beforeEach(() => {
    tree.notesById = { n1: seedNote({ tags: ['keep'] }) };
  });

  it('renameNote patches the in-memory title', async () => {
    await renameNote('n1', 'renamed');
    expect(saveNoteMock).toHaveBeenCalledWith({ id: 'n1', title: 'renamed' });
    expect(tree.notesById.n1.title).toBe('renamed');
  });

  it('setNoteBody bumps the modified timestamp', async () => {
    await setNoteBody('n1', 'body');
    expect(saveNoteMock).toHaveBeenCalledWith({ id: 'n1', body: 'body' });
  });

  it('setNoteFavourite patches the flag', async () => {
    await setNoteFavourite('n1', true);
    expect(tree.notesById.n1.favourite).toBe(true);
  });

  it('setNoteTags normalises and de-dupes', async () => {
    await setNoteTags('n1', [' a ', 'a', 'b']);
    expect(tree.notesById.n1.tags).toEqual(['a', 'b']);
  });

  it('addNoteTag appends, removeNoteTag drops', async () => {
    await addNoteTag('n1', 'extra');
    expect(tree.notesById.n1.tags).toContain('extra');
    await removeNoteTag('n1', 'keep');
    expect(tree.notesById.n1.tags).not.toContain('keep');
  });
});

describe('collection mutations', () => {
  it('createCollectionIn returns the new id', async () => {
    const id = await createCollectionIn(null, 'New folder');
    expect(createCollectionMock).toHaveBeenCalledWith({
      name: 'New folder',
      parent_collection_id: null
    });
    expect(id).toBe('coll_new');
  });

  it('renameCollection calls updateCollection', async () => {
    await renameCollection('coll_1', 'Renamed');
    expect(updateCollectionMock).toHaveBeenCalledWith({
      id: 'coll_1',
      name: 'Renamed'
    });
  });

  it('trashCollection hard-deletes when useTrash is off', async () => {
    await trashCollection('coll_1');
    expect(deleteCollectionMock).toHaveBeenCalledWith('coll_1');
  });

  it('restoreCollection moves it to root', async () => {
    await restoreCollection('coll_1');
    expect(updateCollectionMock).toHaveBeenCalledWith({
      id: 'coll_1',
      parent_collection_id: null
    });
  });

  it('purgeCollection deletes via the api', async () => {
    await purgeCollection('coll_1');
    expect(deleteCollectionMock).toHaveBeenCalledWith('coll_1');
  });
});

describe('emptyTrash', () => {
  it('returns the deletion counts from Rust', async () => {
    const counts = await emptyTrash();
    expect(emptyTrashCmdMock).toHaveBeenCalled();
    expect(counts).toEqual({ notes: 2, folders: 1 });
  });
});
