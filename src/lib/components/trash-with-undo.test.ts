import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  tree: {
    notesById: {} as Record<
      string,
      { title: string; parent_collection_id: string | null }
    >,
    collectionsById: {} as Record<
      string,
      { name: string; parent_collection_id: string | null }
    >
  },
  trashNote: vi.fn(),
  trashCollection: vi.fn(),
  trashMany: vi.fn(),
  moveNoteTo: vi.fn(),
  moveCollectionTo: vi.fn(),
  moveManyTo: vi.fn()
}));

vi.mock('$lib/stores/tree.svelte', () => store);

import { toasts } from './toast.svelte';
import { trashWithUndo } from './trash-with-undo';

function undo() {
  const action = toasts.items.at(-1)?.action;
  expect(action).toBeDefined();
  action!.run();
}

beforeEach(() => {
  vi.clearAllMocks();
  toasts.items.length = 0;
  store.tree.notesById = {
    a: { title: 'Alpha', parent_collection_id: 'projects' },
    b: { title: 'Beta', parent_collection_id: 'projects' },
    c: { title: 'Gamma', parent_collection_id: null }
  };
  store.tree.collectionsById = {
    f: { name: 'Archive', parent_collection_id: 'projects' }
  };
});

describe('trashWithUndo', () => {
  it('trashes a single note at once and names it in the toast', async () => {
    await trashWithUndo([{ kind: 'note', id: 'a' }]);
    expect(store.trashNote).toHaveBeenCalledWith('a');
    expect(toasts.items).toHaveLength(1);
    expect(toasts.items[0].message).toContain('Alpha');
    expect(toasts.items[0].action).toBeDefined();
  });

  it('puts a note back in its original folder on undo', async () => {
    await trashWithUndo([{ kind: 'note', id: 'a' }]);
    undo();
    await vi.waitFor(() =>
      expect(store.moveNoteTo).toHaveBeenCalledWith('a', 'projects')
    );
  });

  it('puts a folder back in its original parent on undo', async () => {
    await trashWithUndo([{ kind: 'folder', id: 'f' }]);
    expect(store.trashCollection).toHaveBeenCalledWith('f');
    undo();
    await vi.waitFor(() =>
      expect(store.moveCollectionTo).toHaveBeenCalledWith('f', 'projects')
    );
  });

  it('restores a batch one group per original folder', async () => {
    const items = [
      { kind: 'note', id: 'a' },
      { kind: 'note', id: 'b' },
      { kind: 'note', id: 'c' }
    ] as const;
    await trashWithUndo(items);
    expect(store.trashMany).toHaveBeenCalledWith(items);
    expect(toasts.items[0].message).toContain('3');
    undo();
    await vi.waitFor(() => {
      expect(store.moveManyTo).toHaveBeenCalledWith(
        [items[0], items[1]],
        'projects'
      );
      expect(store.moveNoteTo).toHaveBeenCalledWith('c', null);
    });
  });

  it('reports a failed trash instead of offering undo', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    store.trashNote.mockRejectedValueOnce(new Error('disk full'));
    await trashWithUndo([{ kind: 'note', id: 'a' }]);
    expect(toasts.items).toHaveLength(1);
    expect(toasts.items[0].variant).toBe('error');
    expect(toasts.items[0].action).toBeUndefined();
  });

  it('does nothing without items', async () => {
    await trashWithUndo([]);
    expect(toasts.items).toHaveLength(0);
  });
});
