import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMenuBuilder, type MenuBuildContext } from './file-explorer-menu';
import type { MenuItem } from './context-menu-types';
import { authSession } from '$lib/api/auth.svelte';
import type { Collection, NoteSummary } from '$lib/api';
import { tree } from '$lib/stores/tree.svelte';
import {
  registerPlugin,
  resetPluginRegistry
} from '$lib/plugins/registry.svelte';

const pluginApi = vi.hoisted(() => ({
  runScript:
    vi.fn<
      (id: string, exportName: string, input: unknown) => Promise<unknown>
    >()
}));

vi.mock('$lib/api/plugins', () => ({
  pluginsRunScript: pluginApi.runScript
}));

const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('./confirm-dialog.svelte', () => ({ confirm: confirmMock }));

// The batch-action handlers fire-and-forget these mutators; stub them so
// invoking an onSelect in a test doesn't leave a floating rejection (the real
// ones need a live vault). The reactive `tree` object is kept real.
vi.mock('$lib/stores/tree.svelte', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/tree.svelte')>()),
  moveManyTo: vi.fn(() => Promise.resolve()),
  purgeMany: vi.fn(() => Promise.resolve()),
  restoreMany: vi.fn(() => Promise.resolve()),
  trashMany: vi.fn(() => Promise.resolve())
}));

function context(overrides: Partial<MenuBuildContext> = {}): MenuBuildContext {
  return {
    source: 'home',
    sourceNodes: [],
    expanded: {},
    selectedKeys: [],
    selectedKeySet: new Set(),
    selectedCount: 0,
    selectionAnchor: null,
    activeKey: null,
    canCreate: true,
    canReorganize: true,
    emptyTrashPending: false,
    trashItemCount: 0,
    rename: null,
    isSharedAnchor: () => false,
    sharedItemEditable: () => true,
    startDraft: () => {},
    startPluginTemplateDraft: () => {},
    startPdfImport: () => {},
    startRename: () => {},
    startEmptyTrash: async () => {},
    leaveShared: async () => {},
    stopSharing: async () => {},
    runNoteExporter: async () => {},
    onOpenNote: () => {},
    ...overrides
  };
}

function labels(items: (MenuItem | 'separator')[]): string[] {
  return items.map((item) => (item === 'separator' ? '---' : item.label));
}

function item(
  items: (MenuItem | 'separator')[],
  label: string
): MenuItem | undefined {
  return items.find(
    (entry): entry is MenuItem => entry !== 'separator' && entry.label === label
  );
}

function note(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: 'n1',
    parent_collection_id: null,
    title: 'Note',
    position: 0,
    created: '2025-01-01T00:00:00Z',
    modified: '2025-01-01T00:00:00Z',
    tags: [],
    trashed: false,
    favourite: false,
    pushed: false,
    note_kind: 'markdown',
    ...overrides
  };
}

function folder(overrides: Partial<Collection> = {}): Collection {
  return {
    id: 'f1',
    parent_collection_id: null,
    name: 'Folder',
    position: 0,
    created: '2025-01-01T00:00:00Z',
    modified: '2025-01-01T00:00:00Z',
    ...overrides
  };
}

beforeEach(() => {
  tree.notesById = {};
  tree.collectionsById = {};
  authSession.current = null;
  resetPluginRegistry();
  pluginApi.runScript.mockReset();
});

describe('root menu', () => {
  it('offers the create actions when the source is writable', () => {
    const { menuItemsForTarget } = createMenuBuilder(context());
    return menuItemsForTarget({ kind: 'root' }).then((items) => {
      expect(labels(items)).toContain('New note');
      expect(labels(items)).toContain('New folder');
    });
  });

  it('is empty when the user may not create anything', async () => {
    const { menuItemsForTarget } = createMenuBuilder(
      context({ canCreate: false, canReorganize: false })
    );
    expect(await menuItemsForTarget({ kind: 'root' })).toEqual([]);
  });

  it('renders plugin file-tree openMenu effects as hover submenus', async () => {
    tree.notesById = { n1: note({ note_kind: 'kanban' }) };
    registerPlugin({
      id: 'com.example.templates',
      name: 'Templates',
      version: '1.0.0',
      runtime: 'luau',
      entry: 'main.luau',
      permissions: ['notes.create'],
      contributes: {
        toolbar: [
          {
            id: 'new-from-template',
            location: 'file-tree',
            labelKey: 'toolbar.newFromTemplate',
            icon: 'icons/templates.svg',
            action: { type: 'script', export: 'newFromTemplate' }
          }
        ],
        i18n: {
          en: {
            'toolbar.newFromTemplate': 'New from template'
          }
        }
      }
    });
    pluginApi.runScript.mockResolvedValue({
      effect: 'openMenu',
      items: [
        {
          label: 'Daily note',
          run: { effect: 'createNoteFromNote', sourceNoteId: 'n1' }
        }
      ]
    });

    const { menuItemsForTarget } = createMenuBuilder(context());
    const items = await menuItemsForTarget({ kind: 'root' });
    const templates = item(items, 'New from template');

    expect(templates?.children?.map((child) => child.label)).toEqual([
      'Daily note'
    ]);
    expect(templates?.pluginIcon).toEqual({
      pluginId: 'com.example.templates',
      file: 'icons/templates.svg'
    });
    expect(templates?.children?.[0]?.noteKind).toBe('kanban');
    expect(templates?.onSelect).toBeUndefined();
    expect(pluginApi.runScript).toHaveBeenCalledWith(
      'com.example.templates',
      'newFromTemplate',
      expect.any(Object)
    );
  });
});

describe('folder create submenu', () => {
  it('offers one entry per enabled note type plus a nested folder', async () => {
    const { folderCreateMenuItems } = createMenuBuilder(context());
    const menuItems = await folderCreateMenuItems('folder-1');
    const items = labels(menuItems);

    expect(items).toContain('New note');
    expect(items).toContain('New folder');
    for (const label of [
      'New note',
      'New drawing canvas',
      'New handwritten note',
      'Import PDF',
      'New Kanban board',
      'New folder'
    ]) {
      expect(
        item(menuItems, label)?.icon,
        `${label} should have an icon`
      ).toBeTruthy();
    }
  });

  it('routes every entry at the folder it was opened on', async () => {
    const drafts: Array<[string, string | null]> = [];
    const { folderCreateMenuItems } = createMenuBuilder(
      context({
        startDraft: (kind, parentId) => drafts.push([kind, parentId]),
        startPdfImport: (parentId) => drafts.push(['pdf', parentId])
      })
    );

    for (const entry of await folderCreateMenuItems('folder-1')) {
      if (entry === 'separator') continue;
      entry.onSelect?.();
    }

    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every(([, parentId]) => parentId === 'folder-1')).toBe(true);
  });
});

describe('batch menu', () => {
  it('is empty for a single item, which uses the per-item menu', async () => {
    const { menuItemsForBatch } = createMenuBuilder(context());
    expect(await menuItemsForBatch([{ kind: 'note', id: 'n1' }])).toEqual([]);
  });

  it('offers restore and delete for a multi-selection in the trash', async () => {
    const { menuItemsForBatch } = createMenuBuilder(
      context({ source: 'trash' })
    );
    const items = labels(
      await menuItemsForBatch([
        { kind: 'note', id: 'n1' },
        { kind: 'note', id: 'n2' }
      ])
    );

    expect(items.some((label) => label.startsWith('Restore'))).toBe(true);
    expect(items.some((label) => label.startsWith('Delete'))).toBe(true);
  });

  it('counts the selection in its labels', async () => {
    const { menuItemsForBatch } = createMenuBuilder(
      context({ source: 'trash' })
    );
    const items = labels(
      await menuItemsForBatch([
        { kind: 'note', id: 'n1' },
        { kind: 'note', id: 'n2' },
        { kind: 'folder', id: 'f1' }
      ])
    );

    expect(items.some((label) => label.includes('3 items'))).toBe(true);
  });

  it('offers move and delete for a home multi-selection when reorganizing is allowed', async () => {
    const { menuItemsForBatch } = createMenuBuilder(context());

    const items = labels(
      await menuItemsForBatch([
        { kind: 'note', id: 'n1' },
        { kind: 'folder', id: 'f1' }
      ])
    );

    expect(items).toContain('Move 2 items to root');
    expect(items).toContain('Delete 2 items');
  });

  it('hides shared batch actions across mixed or read-only scopes', async () => {
    tree.notesById = {
      n1: note({ id: 'n1', parent_collection_id: 'shared-a' }),
      n2: note({ id: 'n2', parent_collection_id: 'shared-b' })
    };
    tree.collectionsById = {
      'shared-a': folder({
        id: 'shared-a',
        share_id: 'scope-a',
        shared_role: 'read_write'
      }),
      'shared-b': folder({
        id: 'shared-b',
        share_id: 'scope-b',
        shared_role: 'read_write'
      })
    };
    const { menuItemsForBatch } = createMenuBuilder(
      context({ source: 'shared' })
    );

    expect(
      await menuItemsForBatch([
        { kind: 'note', id: 'n1' },
        { kind: 'note', id: 'n2' }
      ])
    ).toEqual([]);

    tree.notesById.n2.parent_collection_id = 'shared-a';
    tree.collectionsById['shared-a'].shared_role = 'read_only';

    expect(
      await menuItemsForBatch([
        { kind: 'note', id: 'n1' },
        { kind: 'note', id: 'n2' }
      ])
    ).toEqual([]);
  });

  it('offers delete for a uniform editable shared selection', async () => {
    tree.notesById = {
      n1: note({ id: 'n1', parent_collection_id: 'shared-a' }),
      n2: note({ id: 'n2', parent_collection_id: 'shared-a' })
    };
    tree.collectionsById = {
      'shared-a': folder({
        id: 'shared-a',
        share_id: 'scope-a',
        shared_role: 'read_write'
      })
    };
    const { menuItemsForBatch } = createMenuBuilder(
      context({ source: 'shared' })
    );

    expect(
      labels(
        await menuItemsForBatch([
          { kind: 'note', id: 'n1' },
          { kind: 'note', id: 'n2' }
        ])
      )
    ).toEqual(['Delete 2 items']);
  });
});

describe('note menu', () => {
  it('offers normal note actions including split/open commands', async () => {
    tree.notesById = { n1: note({ title: 'Draft' }) };
    const opened: string[] = [];
    const renamed: string[] = [];
    const { menuItemsForTarget } = createMenuBuilder(
      context({
        onOpenNoteRight: (id) => opened.push(`right:${id}`),
        onOpenNoteBelow: (id) => opened.push(`below:${id}`),
        onOpenInNewWindow: (id) => opened.push(`window:${id}`),
        startRename: (_kind, id, current) => renamed.push(`${id}:${current}`)
      })
    );

    const items = await menuItemsForTarget({ kind: 'note', id: 'n1' });

    expect(labels(items)).toEqual([
      'Open',
      'Open to the right',
      'Open below',
      'Open in new window',
      '---',
      'Rename…',
      'Move to root',
      '---',
      'Delete'
    ]);

    item(items, 'Open to the right')?.onSelect?.();
    item(items, 'Open below')?.onSelect?.();
    item(items, 'Open in new window')?.onSelect?.();
    item(items, 'Rename…')?.onSelect?.();

    expect(opened).toEqual(['right:n1', 'below:n1', 'window:n1']);
    expect(renamed).toEqual(['n1:Draft']);
  });

  it('keeps read-only shared notes open-only', async () => {
    tree.notesById = {
      n1: note({ parent_collection_id: 'shared-root' })
    };
    tree.collectionsById = {
      'shared-root': folder({
        id: 'shared-root',
        share_id: 'scope-a',
        shared_role: 'read_only'
      })
    };
    const { menuItemsForTarget } = createMenuBuilder(
      context({
        source: 'shared',
        sharedItemEditable: () => false
      })
    );

    expect(
      labels(await menuItemsForTarget({ kind: 'note', id: 'n1' }))
    ).toEqual(['Open']);
  });

  it('allows rename and delete for editable shared notes without moving them to root', async () => {
    tree.notesById = {
      n1: note({ parent_collection_id: 'shared-root' })
    };
    tree.collectionsById = {
      'shared-root': folder({
        id: 'shared-root',
        share_id: 'scope-a',
        shared_role: 'read_write'
      })
    };
    const { menuItemsForTarget } = createMenuBuilder(
      context({
        source: 'shared',
        sharedItemEditable: () => true
      })
    );

    expect(
      labels(await menuItemsForTarget({ kind: 'note', id: 'n1' }))
    ).toEqual(['Open', '---', 'Rename…', 'Delete']);
  });
});

describe('folder menu', () => {
  it('adds owner sharing actions for signed-in shared-by-me folders', async () => {
    authSession.current = {
      username: 'alice',
      server_url: 'https://example.invalid'
    };
    tree.collectionsById = {
      f1: folder({ shared_by_me: true })
    };
    const { menuItemsForTarget } = createMenuBuilder(context());

    const items = await menuItemsForTarget({ kind: 'folder', id: 'f1' });
    const sharing = item(items, 'Sharing');

    expect(sharing?.children?.map((child) => child.label)).toEqual([
      'Share folder…',
      'Manage access…',
      'Stop sharing…'
    ]);
  });

  it('offers leave and manage actions for editable shared root anchors', async () => {
    tree.collectionsById = {
      f1: folder({ share_id: 'scope-a', shared_role: 'admin' })
    };
    const { menuItemsForTarget } = createMenuBuilder(
      context({
        source: 'shared',
        isSharedAnchor: () => true
      })
    );

    const items = await menuItemsForTarget({ kind: 'folder', id: 'f1' });

    expect(labels(items)).toContain('Sharing');
    expect(labels(items)).toContain('Leave shared folder…');
    expect(labels(items)).not.toContain('Rename folder…');
    expect(labels(items)).not.toContain('Delete');
  });

  it('hides read-only shared sub-folders', async () => {
    tree.collectionsById = {
      root: folder({
        id: 'root',
        share_id: 'scope-a',
        shared_role: 'read_only'
      }),
      child: folder({ id: 'child', parent_collection_id: 'root' })
    };
    const { menuItemsForTarget } = createMenuBuilder(
      context({ source: 'shared' })
    );

    expect(await menuItemsForTarget({ kind: 'folder', id: 'child' })).toEqual(
      []
    );
  });

  it('uses trash folder actions for folders under trash', async () => {
    tree.collectionsById = {
      trash: folder({ id: 'trash', name: 'Trash' }),
      f1: folder({ parent_collection_id: 'trash' })
    };
    const { menuItemsForTarget } = createMenuBuilder(context());

    expect(
      labels(await menuItemsForTarget({ kind: 'folder', id: 'f1' }))
    ).toEqual(['Restore', 'Delete permanently']);
  });

  it('shows empty-trash state from the root trash menu', async () => {
    const { menuItemsForTarget } = createMenuBuilder(
      context({
        source: 'trash',
        trashItemCount: 0,
        emptyTrashPending: true
      })
    );

    const items = await menuItemsForTarget({ kind: 'root' });

    expect(labels(items)).toEqual(['Empty trash (0)']);
    expect(item(items, 'Empty trash (0)')?.disabled).toBe(true);
  });
});

describe('batch menu — handler bodies', () => {
  const twoItems = [
    { kind: 'note' as const, id: 'n1' },
    { kind: 'note' as const, id: 'n2' }
  ];

  it('runs trash restore/purge handlers (purge gated on confirm)', async () => {
    confirmMock.mockReset().mockResolvedValue(true);
    const { menuItemsForBatch } = createMenuBuilder(
      context({ source: 'trash' })
    );
    const built = await menuItemsForBatch(twoItems);
    for (const entry of built) {
      if (entry !== 'separator' && entry.onSelect) await entry.onSelect();
    }
    expect(confirmMock).toHaveBeenCalled();
  });

  it('does not purge when the confirm is declined', async () => {
    confirmMock.mockReset().mockResolvedValue(false);
    const { menuItemsForBatch } = createMenuBuilder(
      context({ source: 'trash' })
    );
    const built = await menuItemsForBatch(twoItems);
    const del = built.find(
      (e) => e !== 'separator' && e.label.includes('permanently')
    ) as MenuItem;
    await del.onSelect?.();
    expect(confirmMock).toHaveBeenCalled();
  });

  it('runs home batch move + delete handlers', async () => {
    confirmMock.mockReset().mockResolvedValue(true);
    const { menuItemsForBatch } = createMenuBuilder(context());
    const built = await menuItemsForBatch(twoItems);
    for (const entry of built) {
      if (entry !== 'separator' && entry.onSelect) await entry.onSelect();
    }
    expect(built.length).toBeGreaterThan(0);
  });

  it('returns no batch actions in a read-only / non-reorganizable view', async () => {
    const { menuItemsForBatch } = createMenuBuilder(
      context({ canReorganize: false })
    );
    expect(await menuItemsForBatch(twoItems)).toEqual([]);
  });
});
