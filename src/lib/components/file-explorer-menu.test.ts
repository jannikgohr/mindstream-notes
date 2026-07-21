import { describe, expect, it } from 'vitest';
import { createMenuBuilder, type MenuBuildContext } from './file-explorer-menu';
import type { MenuItem } from './context-menu-types';

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
});

describe('folder create submenu', () => {
  it('offers one entry per enabled note type plus a nested folder', () => {
    const { folderCreateMenuItems } = createMenuBuilder(context());
    const items = labels(folderCreateMenuItems('folder-1'));

    expect(items).toContain('New note in folder');
    expect(items).toContain('New folder inside');
  });

  it('routes every entry at the folder it was opened on', () => {
    const drafts: Array<[string, string | null]> = [];
    const { folderCreateMenuItems } = createMenuBuilder(
      context({
        startDraft: (kind, parentId) => drafts.push([kind, parentId]),
        startPdfImport: (parentId) => drafts.push(['pdf', parentId])
      })
    );

    for (const item of folderCreateMenuItems('folder-1')) {
      item.onSelect?.();
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
});
