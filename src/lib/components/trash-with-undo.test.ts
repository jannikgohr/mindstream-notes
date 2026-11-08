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

type Item = { kind: 'note' | 'folder'; id: string };

/** Move an item in the fake tree, as the real store's reload would. */
function place(item: Item, parent: string | null) {
  const node =
    item.kind === 'note'
      ? store.tree.notesById[item.id]
      : store.tree.collectionsById[item.id];
  node.parent_collection_id = parent;
}

beforeEach(() => {
  vi.resetAllMocks();
  toasts.items.length = 0;
  store.tree.notesById = {
    a: { title: 'Alpha', parent_collection_id: 'projects' },
    b: { title: 'Beta', parent_collection_id: 'projects' },
    c: { title: 'Gamma', parent_collection_id: null }
  };
  store.tree.collectionsById = {
    trash: { name: 'Trash', parent_collection_id: null },
    projects: { name: 'Projects', parent_collection_id: null },
    f: { name: 'Archive', parent_collection_id: 'projects' }
  };
  store.trashNote.mockImplementation(async (id: string) =>
    place({ kind: 'note', id }, 'trash')
  );
  store.trashCollection.mockImplementation(async (id: string) =>
    place({ kind: 'folder', id }, 'trash')
  );
  store.trashMany.mockImplementation(async (items: Item[]) =>
    items.forEach((item) => place(item, 'trash'))
  );
  store.moveNoteTo.mockImplementation(
    async (id: string, parent: string | null) =>
      place({ kind: 'note', id }, parent)
  );
  store.moveCollectionTo.mockImplementation(
    async (id: string, parent: string | null) =>
      place({ kind: 'folder', id }, parent)
  );
  store.moveManyTo.mockImplementation(
    async (items: Item[], parent: string | null) =>
      items.forEach((item) => place(item, parent))
  );
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

  it('puts a note back at the root when its folder was trashed since', async () => {
    store.tree.notesById.a.parent_collection_id = 'f';
    await trashWithUndo([{ kind: 'note', id: 'a' }]);
    await trashWithUndo([{ kind: 'folder', id: 'f' }]);
    toasts.items[0].action!.run();
    await vi.waitFor(() =>
      expect(store.moveNoteTo).toHaveBeenCalledWith('a', null)
    );
  });

  it('puts a note back at the root when its folder was deleted since', async () => {
    await trashWithUndo([{ kind: 'note', id: 'a' }]);
    delete store.tree.collectionsById.projects;
    undo();
    await vi.waitFor(() =>
      expect(store.moveNoteTo).toHaveBeenCalledWith('a', null)
    );
  });

  it('ignores an older undo once the note was moved and trashed again', async () => {
    await trashWithUndo([{ kind: 'note', id: 'a' }]);
    const first = toasts.items[0].action!;
    place({ kind: 'note', id: 'a' }, 'elsewhere');
    await trashWithUndo([{ kind: 'note', id: 'a' }]);
    first.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.moveNoteTo).not.toHaveBeenCalled();
    expect(store.tree.notesById.a.parent_collection_id).toBe('trash');
  });

  it('leaves a note alone that was already restored from the trash', async () => {
    await trashWithUndo([{ kind: 'note', id: 'a' }]);
    place({ kind: 'note', id: 'a' }, 'elsewhere');
    undo();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.moveNoteTo).not.toHaveBeenCalled();
  });

  it('keeps putting groups back after one group fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await trashWithUndo([
      { kind: 'note', id: 'a' },
      { kind: 'note', id: 'c' }
    ]);
    store.moveNoteTo.mockRejectedValueOnce(new Error('disk full'));
    undo();
    await vi.waitFor(() => {
      expect(store.moveNoteTo).toHaveBeenCalledWith('a', 'projects');
      expect(store.moveNoteTo).toHaveBeenCalledWith('c', null);
    });
    await vi.waitFor(() => expect(toasts.items.at(-1)?.variant).toBe('error'));
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
