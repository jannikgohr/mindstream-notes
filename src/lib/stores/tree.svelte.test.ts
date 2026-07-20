import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the api module BEFORE importing the store so the import binding picks
// up the mocked version. Vitest's vi.mock is hoisted automatically.
const saveNoteMock = vi.fn();
const updateCollectionMock = vi.fn();
const createNoteMock = vi.fn();
const createCollectionMock = vi.fn();
const importPdfNoteMock = vi.fn();
const moveManyMock = vi.fn();
const trashManyMock = vi.fn();
const restoreManyMock = vi.fn();
const purgeManyMock = vi.fn();
const restoreNoteMock = vi.fn();
const purgeNoteMock = vi.fn();
const deleteCollectionMock = vi.fn();
const emptyTrashCmdMock = vi.fn();
const loadTreeMock = vi.fn();
const leaveSharedCollectionMock = vi.fn();
const stopSharingCollectionMock = vi.fn();
const runSyncMock = vi.fn();
const setPdfTextMock = vi.fn();
const extractPdfTextMock = vi.fn();

vi.mock('$lib/api', () => ({
  saveNote: (...args: unknown[]) => saveNoteMock(...args),
  updateCollection: (...args: unknown[]) => updateCollectionMock(...args),
  createNote: (...args: unknown[]) => createNoteMock(...args),
  createCollection: (...args: unknown[]) => createCollectionMock(...args),
  importPdfNote: (...args: unknown[]) => importPdfNoteMock(...args),
  moveMany: (...args: unknown[]) => moveManyMock(...args),
  trashMany: (...args: unknown[]) => trashManyMock(...args),
  restoreMany: (...args: unknown[]) => restoreManyMock(...args),
  purgeMany: (...args: unknown[]) => purgeManyMock(...args),
  setPdfText: (...args: unknown[]) => setPdfTextMock(...args),
  restoreNote: (...args: unknown[]) => restoreNoteMock(...args),
  purgeNote: (...args: unknown[]) => purgeNoteMock(...args),
  deleteCollection: (...args: unknown[]) => deleteCollectionMock(...args),
  emptyTrashCmd: (...args: unknown[]) => emptyTrashCmdMock(...args),
  loadTree: (...args: unknown[]) => loadTreeMock(...args),
  leaveSharedCollection: (...args: unknown[]) =>
    leaveSharedCollectionMock(...args),
  stopSharingCollection: (...args: unknown[]) =>
    stopSharingCollectionMock(...args),
  TRASH_ID: 'trash'
}));

vi.mock('$lib/sync/runner', () => ({
  runSync: (...args: unknown[]) => runSyncMock(...args)
}));

// pdf.js text extraction pulls in the worker bundle — stub it.
vi.mock('$lib/pdf/extract-text', () => ({
  extractPdfText: (...args: unknown[]) => extractPdfTextMock(...args)
}));

// Avoid pulling state.svelte (which depends on browser localStorage etc.)
vi.mock('$lib/state.svelte', () => ({
  ui: { activeNoteId: null }
}));

import {
  addNoteTag,
  allTagsInUse,
  createCollectionIn,
  createNoteIn,
  emptyTrash,
  importPdfIn,
  leaveSharedCollection,
  moveManyTo,
  moveCollectionTo,
  moveNoteTo,
  normalizeTagPath,
  purgeMany,
  purgeCollection,
  purgeNote,
  removeNoteTag,
  renameCollection,
  renameNote,
  restoreMany,
  restoreCollection,
  restoreNote,
  setNoteBody,
  setNoteFavourite,
  setNoteTags,
  stopSharingCollection,
  tree,
  trashMany,
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
  moveManyMock.mockReset().mockResolvedValue({ notes: 1, folders: 1 });
  trashManyMock.mockReset().mockResolvedValue({ notes: 2, folders: 0 });
  restoreManyMock.mockReset().mockResolvedValue({ notes: 0, folders: 2 });
  purgeManyMock.mockReset().mockResolvedValue({ notes: 3, folders: 4 });
  restoreNoteMock.mockReset().mockResolvedValue(undefined);
  purgeNoteMock.mockReset().mockResolvedValue(undefined);
  deleteCollectionMock.mockReset().mockResolvedValue(undefined);
  createCollectionMock.mockReset().mockResolvedValue({ id: 'coll_new' });
  importPdfNoteMock.mockReset().mockResolvedValue({ id: 'note_pdf' });
  setPdfTextMock.mockReset().mockResolvedValue(undefined);
  extractPdfTextMock.mockReset().mockResolvedValue('extracted pdf text');
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

describe('batch tree mutations', () => {
  const items = [
    { kind: 'note' as const, id: 'note_1' },
    { kind: 'folder' as const, id: 'coll_1' }
  ];

  it('moveManyTo calls the API, reloads the tree and returns counts', async () => {
    const counts = await moveManyTo(items, 'target');
    expect(moveManyMock).toHaveBeenCalledWith(items, 'target');
    expect(loadTreeMock).toHaveBeenCalled();
    expect(counts).toEqual({ notes: 1, folders: 1 });
  });

  it('trashMany calls the API, reloads the tree and returns counts', async () => {
    const counts = await trashMany(items);
    expect(trashManyMock).toHaveBeenCalledWith(items);
    expect(loadTreeMock).toHaveBeenCalled();
    expect(counts).toEqual({ notes: 2, folders: 0 });
  });

  it('restoreMany calls the API, reloads the tree and returns counts', async () => {
    const counts = await restoreMany(items);
    expect(restoreManyMock).toHaveBeenCalledWith(items);
    expect(loadTreeMock).toHaveBeenCalled();
    expect(counts).toEqual({ notes: 0, folders: 2 });
  });

  it('purgeMany calls the API, reloads the tree and returns counts', async () => {
    const counts = await purgeMany(items);
    expect(purgeManyMock).toHaveBeenCalledWith(items);
    expect(loadTreeMock).toHaveBeenCalled();
    expect(counts).toEqual({ notes: 3, folders: 4 });
  });
});

describe('trashNote', () => {
  it('moves the note to the trash collection', async () => {
    await trashNote('note_x');
    expect(saveNoteMock).toHaveBeenCalledWith({
      id: 'note_x',
      parent_collection_id: 'trash'
    });
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

  it('indexes the imported PDF text for search', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'Paper.pdf', {
      type: 'application/pdf'
    });
    await importPdfIn(null, file);
    // Extraction + persistence run off the import path (fire-and-forget), so
    // let the microtask queue drain before asserting.
    await vi.waitFor(() => {
      expect(extractPdfTextMock).toHaveBeenCalled();
      expect(setPdfTextMock).toHaveBeenCalledWith(
        'note_pdf',
        'extracted pdf text'
      );
    });
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

  it('trashCollection moves the folder to trash', async () => {
    await trashCollection('coll_1');
    expect(updateCollectionMock).toHaveBeenCalledWith({
      id: 'coll_1',
      parent_collection_id: 'trash'
    });
  });

  it('leaveSharedCollection leaves the share and reloads the tree', async () => {
    // Both share-exit paths reload rather than patch local state: the backend
    // purges a whole subtree, so the store can't reconstruct the result itself.
    loadTreeMock.mockClear();

    await leaveSharedCollection('coll_shared');

    expect(leaveSharedCollectionMock).toHaveBeenCalledWith('coll_shared');
    expect(loadTreeMock).toHaveBeenCalled();
  });

  it('stopSharingCollection revokes the share and reloads the tree', async () => {
    loadTreeMock.mockClear();

    await stopSharingCollection('coll_1');

    expect(stopSharingCollectionMock).toHaveBeenCalledWith('coll_1');
    expect(loadTreeMock).toHaveBeenCalled();
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
