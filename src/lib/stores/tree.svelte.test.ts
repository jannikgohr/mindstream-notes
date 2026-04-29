import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the api module BEFORE importing the store so the import binding picks
// up the mocked version. Vitest's vi.mock is hoisted automatically.
const saveNoteMock = vi.fn();
const updateCollectionMock = vi.fn();
const createNoteMock = vi.fn();
const trashNoteMock = vi.fn();
const loadTreeMock = vi.fn();

vi.mock('$lib/api', () => ({
  saveNote: (...args: unknown[]) => saveNoteMock(...args),
  updateCollection: (...args: unknown[]) => updateCollectionMock(...args),
  createNote: (...args: unknown[]) => createNoteMock(...args),
  trashNote: (...args: unknown[]) => trashNoteMock(...args),
  loadTree: (...args: unknown[]) => loadTreeMock(...args)
}));

// Avoid pulling state.svelte (which depends on browser localStorage etc.)
vi.mock('$lib/state.svelte', () => ({
  ui: { activeNoteId: null }
}));

// The store is .svelte.ts so its $state runes work in vitest's happy-dom env.
import {
  moveCollectionTo,
  moveNoteTo,
  trashNoteById
} from './tree.svelte';

beforeEach(() => {
  saveNoteMock.mockReset().mockResolvedValue(undefined);
  updateCollectionMock.mockReset().mockResolvedValue(undefined);
  createNoteMock.mockReset().mockResolvedValue(undefined);
  trashNoteMock.mockReset().mockResolvedValue(undefined);
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

describe('trashNoteById', () => {
  it('calls trashNote and refreshes (via internal removal)', async () => {
    await trashNoteById('note_x');
    expect(trashNoteMock).toHaveBeenCalledWith('note_x');
  });
});
