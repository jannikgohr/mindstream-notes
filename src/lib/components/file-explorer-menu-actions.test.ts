/**
 * `onSelect` wiring for the file-tree context menu.
 *
 * `file-explorer-menu.test.ts` asserts *which* entries each menu offers.
 * This file is the complementary half: it invokes the `onSelect` of every
 * entry and proves each one runs the command the explorer wired in through
 * `MenuBuildContext` (or the right store mutator). All side-effectful
 * dependencies — the store mutators, confirm dialog, share dialog, plugin
 * and exporter lookups — are mocked so choosing an entry stays a pure
 * function call.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuItem } from './context-menu-types';
import type { Collection, NoteSummary } from '$lib/api';

const h = vi.hoisted(() => ({
  noteTypeEnabled: vi.fn((_kind: string): boolean => true),
  confirm: vi.fn(() => Promise.resolve(true)),
  exportersForNote: vi.fn(
    () => [] as { id: string; label: string; run: unknown }[]
  ),
  openCollectionShareDialog: vi.fn(),
  pluginTemplateEntries: vi.fn(
    () => [] as { pluginId: string; templateId: string; label: string }[]
  ),
  pluginToolbarButtons: vi.fn(() => [] as unknown[]),
  moveNoteTo: vi.fn(() => Promise.resolve()),
  moveCollectionTo: vi.fn(() => Promise.resolve()),
  restoreNote: vi.fn(() => Promise.resolve()),
  restoreCollection: vi.fn(() => Promise.resolve()),
  purgeNote: vi.fn(() => Promise.resolve()),
  purgeCollection: vi.fn(() => Promise.resolve()),
  trashNote: vi.fn(() => Promise.resolve()),
  trashCollection: vi.fn(() => Promise.resolve()),
  restoreMany: vi.fn(() => Promise.resolve()),
  purgeMany: vi.fn(() => Promise.resolve()),
  trashMany: vi.fn(() => Promise.resolve()),
  moveManyTo: vi.fn(() => Promise.resolve()),
  collectionIsUnderTrash: vi.fn(() => false),
  noteIsUnderTrash: vi.fn(() => false),
  noteIsUnderShared: vi.fn(() => false),
  sharedFolderIsEditable: vi.fn(() => true),
  collectionUserCanManageSharing: vi.fn(() => true),
  collectionScopeIsReadOnly: vi.fn(() => false),
  collectionIsSharedByMe: vi.fn(() => true),
  itemSharedRootId: vi.fn(() => 'root')
}));

vi.mock('$lib/notes/note-types', () => ({
  noteTypeEnabled: h.noteTypeEnabled
}));
vi.mock('./confirm-dialog.svelte', () => ({ confirm: h.confirm }));
vi.mock('$lib/note-exporters', () => ({
  exportersForNote: h.exportersForNote
}));
vi.mock('./share-dialog.svelte', () => ({
  openCollectionShareDialog: h.openCollectionShareDialog
}));
vi.mock('$lib/plugins/menu', () => ({
  pluginTemplateEntries: h.pluginTemplateEntries
}));
vi.mock('$lib/plugins/registry.svelte', () => ({
  pluginToolbarButtons: h.pluginToolbarButtons
}));
vi.mock('$lib/stores/tree.svelte', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/tree.svelte')>()),
  moveNoteTo: h.moveNoteTo,
  moveCollectionTo: h.moveCollectionTo,
  restoreNote: h.restoreNote,
  restoreCollection: h.restoreCollection,
  purgeNote: h.purgeNote,
  purgeCollection: h.purgeCollection,
  trashNote: h.trashNote,
  trashCollection: h.trashCollection,
  restoreMany: h.restoreMany,
  purgeMany: h.purgeMany,
  trashMany: h.trashMany,
  moveManyTo: h.moveManyTo
}));
vi.mock('$lib/stores/note-source.svelte', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/note-source.svelte')>()),
  collectionIsUnderTrash: h.collectionIsUnderTrash,
  noteIsUnderTrash: h.noteIsUnderTrash,
  noteIsUnderShared: h.noteIsUnderShared,
  sharedFolderIsEditable: h.sharedFolderIsEditable,
  collectionUserCanManageSharing: h.collectionUserCanManageSharing,
  collectionScopeIsReadOnly: h.collectionScopeIsReadOnly,
  collectionIsSharedByMe: h.collectionIsSharedByMe,
  itemSharedRootId: h.itemSharedRootId
}));

import { createMenuBuilder, type MenuBuildContext } from './file-explorer-menu';
import { tree } from '$lib/stores/tree.svelte';
import { authSession } from '$lib/api/auth.svelte';

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
    startDraft: vi.fn(),
    startPluginTemplateDraft: vi.fn(),
    startPdfImport: vi.fn(),
    startRename: vi.fn(),
    startEmptyTrash: vi.fn(async () => {}),
    leaveShared: vi.fn(async () => {}),
    stopSharing: vi.fn(async () => {}),
    runNoteExporter: vi.fn(async () => {}),
    onOpenNote: vi.fn(),
    ...overrides
  };
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

type Entry = MenuItem | 'separator';

/** Depth-first invoke every `onSelect`, awaiting async handlers. */
async function runAll(items: Entry[]): Promise<void> {
  for (const it of items) {
    if (it === 'separator') continue;
    if (it.children) await runAll(it.children as Entry[]);
    if (it.onSelect) await it.onSelect();
  }
}

function find(items: Entry[], label: string): MenuItem {
  const hit = items.find(
    (e): e is MenuItem => e !== 'separator' && e.label === label
  );
  if (!hit) throw new Error(`no menu item "${label}"`);
  return hit;
}

beforeEach(() => {
  tree.notesById = {};
  tree.collectionsById = {};
  authSession.current = null;
  vi.clearAllMocks();
  h.noteTypeEnabled.mockImplementation(() => true);
  h.confirm.mockResolvedValue(true);
  h.exportersForNote.mockReturnValue([]);
  h.pluginTemplateEntries.mockReturnValue([]);
  h.collectionIsUnderTrash.mockReturnValue(false);
  h.noteIsUnderTrash.mockReturnValue(false);
  h.noteIsUnderShared.mockReturnValue(false);
  h.sharedFolderIsEditable.mockReturnValue(true);
});

describe('root create actions', () => {
  it('each entry starts the matching draft, including a plugin template', async () => {
    h.pluginTemplateEntries.mockReturnValue([
      { pluginId: 'com.x', templateId: 'letter', label: 'Letter' }
    ]);
    const ctx = context();
    const { menuItemsForTarget } = createMenuBuilder(ctx);
    const items = await menuItemsForTarget({ kind: 'root' });

    find(items, 'New note').onSelect!();
    expect(ctx.startDraft).toHaveBeenCalledWith('note', null);
    find(items, 'New drawing canvas').onSelect!();
    expect(ctx.startDraft).toHaveBeenCalledWith('drawing', null);
    find(items, 'New handwritten note').onSelect!();
    expect(ctx.startDraft).toHaveBeenCalledWith('ink', null);
    find(items, 'Import PDF').onSelect!();
    expect(ctx.startPdfImport).toHaveBeenCalledWith(null);
    find(items, 'New folder').onSelect!();
    expect(ctx.startDraft).toHaveBeenCalledWith('folder', null);
    find(items, 'Letter').onSelect!();
    expect(ctx.startPluginTemplateDraft).toHaveBeenCalledWith(
      'com.x',
      'letter',
      null
    );
  });

  it('drops the optional note kinds when their toggles are off', async () => {
    h.noteTypeEnabled.mockImplementation((k: string) => k === 'markdown');
    const { menuItemsForTarget } = createMenuBuilder(context());
    const items = await menuItemsForTarget({ kind: 'root' });
    const labels = items.map((i) => (i === 'separator' ? '---' : i.label));
    expect(labels).toEqual(['New note', 'New folder']);
  });
});

describe('note actions (home)', () => {
  it('wires open / export / rename / move / delete', async () => {
    tree.notesById = { n1: note() };
    const runExport = vi.fn();
    h.exportersForNote.mockReturnValue([
      { id: 'md', label: 'Markdown', run: runExport }
    ]);
    const ctx = context({
      onOpenNoteRight: vi.fn(),
      onOpenNoteBelow: vi.fn(),
      onOpenInNewWindow: vi.fn()
    });
    const { menuItemsForTarget } = createMenuBuilder(ctx);
    const items = await menuItemsForTarget({ kind: 'note', id: 'n1' });

    find(items, 'Open').onSelect!();
    expect(ctx.onOpenNote).toHaveBeenCalledWith('n1');
    find(items, 'Open to the right').onSelect!();
    expect(ctx.onOpenNoteRight).toHaveBeenCalledWith('n1');
    find(items, 'Open below').onSelect!();
    expect(ctx.onOpenNoteBelow).toHaveBeenCalledWith('n1');
    find(items, 'Open in new window').onSelect!();
    expect(ctx.onOpenInNewWindow).toHaveBeenCalledWith('n1');

    const exportGroup = find(items, 'Export');
    (exportGroup.children![0] as MenuItem).onSelect!();
    expect(ctx.runNoteExporter).toHaveBeenCalledWith(
      'n1',
      'Markdown',
      expect.any(Function)
    );

    find(items, 'Rename…').onSelect!();
    expect(ctx.startRename).toHaveBeenCalledWith('note', 'n1', 'Note');
    find(items, 'Move to root').onSelect!();
    expect(h.moveNoteTo).toHaveBeenCalledWith('n1', null);
    find(items, 'Delete').onSelect!();
    expect(h.trashNote).toHaveBeenCalledWith('n1');
  });
});

describe('note actions (trash)', () => {
  it('restores and permanently deletes (with confirm)', async () => {
    tree.notesById = { n1: note() };
    const ctx = context({ source: 'trash' });
    const { menuItemsForTarget } = createMenuBuilder(ctx);
    const items = await menuItemsForTarget({ kind: 'note', id: 'n1' });

    find(items, 'Open').onSelect!();
    expect(ctx.onOpenNote).toHaveBeenCalledWith('n1');
    find(items, 'Restore').onSelect!();
    expect(h.restoreNote).toHaveBeenCalledWith('n1');

    await find(items, 'Delete permanently').onSelect!();
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(h.purgeNote).toHaveBeenCalledWith('n1');
  });

  it('does not purge when the confirm is declined', async () => {
    tree.notesById = { n1: note() };
    h.confirm.mockResolvedValue(false);
    const { menuItemsForTarget } = createMenuBuilder(
      context({ source: 'trash' })
    );
    const items = await menuItemsForTarget({ kind: 'note', id: 'n1' });

    await find(items, 'Delete permanently').onSelect!();
    expect(h.purgeNote).not.toHaveBeenCalled();
  });
});

describe('note actions (editable shared scope)', () => {
  it('offers rename + delete routed into the scope', async () => {
    tree.notesById = { n1: note() };
    const ctx = context({ source: 'shared', sharedItemEditable: () => true });
    const { menuItemsForTarget } = createMenuBuilder(ctx);
    const items = await menuItemsForTarget({ kind: 'note', id: 'n1' });

    find(items, 'Rename…').onSelect!();
    expect(ctx.startRename).toHaveBeenCalledWith('note', 'n1', 'Note');
    find(items, 'Delete').onSelect!();
    expect(h.trashNote).toHaveBeenCalledWith('n1');
  });
});

describe('folder actions (home)', () => {
  it('wires create-inside, rename, move, sharing and delete', async () => {
    tree.collectionsById = { f1: folder() };
    authSession.current = { server_type: 'etebase' } as never;
    const ctx = context();
    const { menuItemsForTarget } = createMenuBuilder(ctx);
    const items = await menuItemsForTarget({ kind: 'folder', id: 'f1' });

    find(items, 'New note in folder').onSelect!();
    expect(ctx.startDraft).toHaveBeenCalledWith('note', 'f1');
    find(items, 'Rename folder…').onSelect!();
    expect(ctx.startRename).toHaveBeenCalledWith('folder', 'f1', 'Folder');
    find(items, 'Move to root').onSelect!();
    expect(h.moveCollectionTo).toHaveBeenCalledWith('f1', null);
    find(items, 'Delete').onSelect!();
    expect(h.trashCollection).toHaveBeenCalledWith('f1');

    // Sharing group children (labels are i18n-resolved, so drive them all).
    await runAll(items);
    expect(h.openCollectionShareDialog).toHaveBeenCalledWith('f1', 'invite');
    expect(h.openCollectionShareDialog).toHaveBeenCalledWith('f1', 'access');
    expect(ctx.stopSharing).toHaveBeenCalledWith('f1');
  });
});

describe('folder actions (trash)', () => {
  it('restores and permanently deletes the folder', async () => {
    tree.collectionsById = { f1: folder() };
    h.collectionIsUnderTrash.mockReturnValue(true);
    const { menuItemsForTarget } = createMenuBuilder(
      context({ source: 'trash' })
    );
    const items = await menuItemsForTarget({ kind: 'folder', id: 'f1' });

    find(items, 'Restore').onSelect!();
    expect(h.restoreCollection).toHaveBeenCalledWith('f1');
    await find(items, 'Delete permanently').onSelect!();
    expect(h.purgeCollection).toHaveBeenCalledWith('f1');
  });
});

describe('folder actions (shared)', () => {
  it('anchor folder offers share management and leave', async () => {
    tree.collectionsById = { f1: folder() };
    const ctx = context({
      source: 'shared',
      isSharedAnchor: (id) => id === 'f1'
    });
    const { menuItemsForTarget } = createMenuBuilder(ctx);
    const items = await menuItemsForTarget({ kind: 'folder', id: 'f1' });

    await runAll(items);
    expect(h.openCollectionShareDialog).toHaveBeenCalledWith('f1', 'invite');
    expect(h.openCollectionShareDialog).toHaveBeenCalledWith('f1', 'access');
    expect(ctx.leaveShared).toHaveBeenCalledWith('f1');
  });

  it('editable sub-folder offers create, rename and delete', async () => {
    tree.collectionsById = { f1: folder() };
    const ctx = context({ source: 'shared', isSharedAnchor: () => false });
    const { menuItemsForTarget } = createMenuBuilder(ctx);
    const items = await menuItemsForTarget({ kind: 'folder', id: 'f1' });

    find(items, 'Rename folder…').onSelect!();
    expect(ctx.startRename).toHaveBeenCalledWith('folder', 'f1', 'Folder');
    find(items, 'Delete').onSelect!();
    expect(h.trashCollection).toHaveBeenCalledWith('f1');
  });
});

describe('batch actions', () => {
  const refs = [
    { kind: 'note' as const, id: 'n1' },
    { kind: 'note' as const, id: 'n2' }
  ];

  it('home batch moves to root and deletes (with confirm)', async () => {
    const { menuItemsForBatch } = createMenuBuilder(context());
    const items = await menuItemsForBatch(refs);

    find(items, 'Move 2 items to root').onSelect!();
    expect(h.moveManyTo).toHaveBeenCalledWith(refs, null);
    await find(items, 'Delete 2 items').onSelect!();
    expect(h.trashMany).toHaveBeenCalledWith(refs);
  });

  it('trash batch restores and permanently deletes', async () => {
    const { menuItemsForBatch } = createMenuBuilder(
      context({ source: 'trash' })
    );
    const items = await menuItemsForBatch(refs);

    find(items, 'Restore 2 items').onSelect!();
    expect(h.restoreMany).toHaveBeenCalledWith(refs);
    await find(items, 'Delete 2 items permanently').onSelect!();
    expect(h.purgeMany).toHaveBeenCalledWith(refs);
  });

  it('shared batch offers a single delete for a uniform editable scope', async () => {
    const { menuItemsForBatch } = createMenuBuilder(
      context({ source: 'shared' })
    );
    const items = await menuItemsForBatch(refs);

    await find(items, 'Delete 2 items').onSelect!();
    expect(h.trashMany).toHaveBeenCalledWith(refs);
  });
});
