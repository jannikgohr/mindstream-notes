import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the api module BEFORE importing the store so the import binding picks
// up the mocked version. Vitest's vi.mock is hoisted automatically.
const saveNoteMock = vi.fn();
const updateCollectionMock = vi.fn();
const createNoteMock = vi.fn();
const trashNoteMock = vi.fn();
const restoreNoteMock = vi.fn();
const purgeNoteMock = vi.fn();
const deleteCollectionMock = vi.fn();
const loadTreeMock = vi.fn();

vi.mock('$lib/api', () => ({
  saveNote: (...args: unknown[]) => saveNoteMock(...args),
  updateCollection: (...args: unknown[]) => updateCollectionMock(...args),
  createNote: (...args: unknown[]) => createNoteMock(...args),
  trashNote: (...args: unknown[]) => trashNoteMock(...args),
  restoreNote: (...args: unknown[]) => restoreNoteMock(...args),
  purgeNote: (...args: unknown[]) => purgeNoteMock(...args),
  deleteCollection: (...args: unknown[]) => deleteCollectionMock(...args),
  loadTree: (...args: unknown[]) => loadTreeMock(...args),
  TRASH_ID: 'trash'
}));

// Avoid pulling state.svelte (which depends on browser localStorage etc.)
vi.mock('$lib/state.svelte', () => ({
  ui: { activeNoteId: null }
}));

// settings/store.svelte transitively imports mode-watcher; stub the surface
// the tree store reads from it instead of trying to resolve the real thing.
vi.mock('$lib/settings/store.svelte', () => ({
  getSettingValue: () => false  // useTrash off → trashNote does hard delete
}));

import {
  moveCollectionTo,
  moveNoteTo,
  purgeNote,
  restoreNote,
  trashNote
} from './tree.svelte';

beforeEach(() => {
  saveNoteMock.mockReset().mockResolvedValue(undefined);
  updateCollectionMock.mockReset().mockResolvedValue(undefined);
  createNoteMock.mockReset().mockResolvedValue(undefined);
  trashNoteMock.mockReset().mockResolvedValue(undefined);
  restoreNoteMock.mockReset().mockResolvedValue(undefined);
  purgeNoteMock.mockReset().mockResolvedValue(undefined);
  deleteCollectionMock.mockReset().mockResolvedValue(undefined);
  loadTreeMock.mockReset().mockResolvedValue({
    tree: [],
    notesById: {},
    collectionsById: {}
  });
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
