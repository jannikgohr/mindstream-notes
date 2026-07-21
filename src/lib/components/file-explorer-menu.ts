/**
 * Building the file-tree context menu.
 *
 * Which entries a right-click offers depends on a lot: what was clicked,
 * how many items are selected, whether the target sits in the trash or
 * inside a shared folder, whether the user may write there, and which
 * note types are enabled. That decision table is this module's whole
 * job — it returns menu *data*, and the commands it wires up are supplied
 * by the explorer through [`MenuBuildContext`].
 */

import { Folder } from '@lucide/svelte';
import type { MenuItem } from './context-menu-types';
import { noteTypeEnabled } from '$lib/notes/note-types';
import { confirm } from './confirm-dialog.svelte';
import {
  tree,
  moveManyTo,
  moveCollectionTo,
  moveNoteTo,
  purgeMany as purgeManyItems,
  purgeCollection,
  purgeNote,
  restoreMany as restoreManyItems,
  restoreCollection,
  restoreNote,
  trashMany as trashManyItems,
  trashCollection,
  trashNote
} from '$lib/stores/tree.svelte';
import { authSession } from '$lib/api/auth.svelte';
import { tUi } from '$lib/settings/i18n.svelte';
import {
  collectionIsSharedByMe,
  collectionUserCanManageSharing,
  collectionIsUnderTrash,
  collectionScopeIsReadOnly,
  itemSharedRootId,
  noteIsUnderShared,
  noteIsUnderTrash,
  sharedFolderIsEditable
} from '$lib/stores/note-source.svelte';
import { openCollectionShareDialog } from './share-dialog.svelte';
import type {
  DraftKind,
  MenuTarget,
  Rename,
  SelectionKey,
  TreeItemRef
} from './file-explorer-helpers';
import type { DesktopNoteSource } from '$lib/stores/note-source.svelte';
import type { TreeNode } from '$lib/api';

/**
 * The explorer state and commands the menu builder reads.
 *
 * Values are getters over the component's `$state`; the functions are the
 * explorer's own actions, so choosing an entry runs the same code path the
 * toolbar and keyboard shortcuts do.
 */
export interface MenuBuildContext {
  readonly source: DesktopNoteSource;
  readonly sourceNodes: TreeNode[];
  readonly expanded: Record<string, boolean>;
  readonly selectedKeys: SelectionKey[];
  readonly selectedKeySet: Set<SelectionKey>;
  readonly selectedCount: number;
  readonly selectionAnchor: SelectionKey | null;
  readonly activeKey: SelectionKey | null;
  readonly canCreate: boolean;
  readonly canReorganize: boolean;
  readonly emptyTrashPending: boolean;
  readonly trashItemCount: number;
  readonly rename: Rename | null;
  isSharedAnchor(folderId: string): boolean;
  sharedItemEditable(item: TreeItemRef): boolean;
  startDraft(kind: DraftKind, parentId: string | null): void;
  startPdfImport(parentId: string | null): void;
  startRename(kind: 'note' | 'folder', id: string, current: string): void;
  startEmptyTrash(): Promise<void>;
  leaveShared(id: string): Promise<void>;
  stopSharing(id: string): Promise<void>;
  runNoteExporter(
    ...args: Parameters<RunNoteExporter>
  ): ReturnType<RunNoteExporter>;
  /** Opening a note — the explorer's own props, forwarded. */
  readonly onOpenNote: (id: string) => void;
  readonly onOpenNoteRight?: (id: string) => void;
  readonly onOpenNoteBelow?: (id: string) => void;
  readonly onOpenInNewWindow?: (id: string) => void;
}

type RunNoteExporter = (
  id: string,
  label: string,
  run: () => Promise<void>
) => Promise<void>;

export function createMenuBuilder(ctx: MenuBuildContext) {
  /**
   * Owner-side sharing actions, grouped into their own submenu and shown only
   * when signed in (sharing is Tauri + Etebase only). Returns `[]` when signed
   * out so the whole group disappears.
   */
  function sharingMenuGroup(
    id: string,
    folder: (typeof tree.collectionsById)[string] | undefined
  ): (MenuItem | 'separator')[] {
    if (!authSession.current) return [];
    const children: MenuItem[] = [
      {
        label: tUi('sharing.menu.shareFolder'),
        onSelect: () => openCollectionShareDialog(id, 'invite')
      }
    ];
    if (folder && collectionIsSharedByMe(folder)) {
      children.push(
        {
          label: tUi('sharing.menu.manageAccess'),
          onSelect: () => openCollectionShareDialog(id, 'access')
        },
        {
          label: tUi('sharing.menu.stopSharing'),
          destructive: true,
          onSelect: () => void ctx.stopSharing(id)
        }
      );
    }
    return [{ label: tUi('sharing.menu.group'), children }];
  }

  function batchLabel(items: TreeItemRef[]): string {
    return `${items.length} item${items.length === 1 ? '' : 's'}`;
  }

  async function menuItemsForBatch(
    items: TreeItemRef[]
  ): Promise<(MenuItem | 'separator')[]> {
    if (items.length <= 1) return [];
    const label = batchLabel(items);

    if (ctx.source === 'trash') {
      return [
        {
          label: `Restore ${label}`,
          onSelect: () => void restoreManyItems(items)
        },
        {
          label: `Delete ${label} permanently`,
          destructive: true,
          onSelect: async () => {
            if (
              await confirm({
                title: 'Delete permanently',
                message: `${label} will be removed. This cannot be undone.`,
                confirmLabel: 'Delete',
                destructive: true
              })
            ) {
              void purgeManyItems(items);
            }
          }
        }
      ];
    }

    const deleteBatchItem: MenuItem = {
      label: `Delete ${label}`,
      shortcut: 'Del',
      destructive: true,
      onSelect: async () => {
        if (
          await confirm({
            title: `Delete ${label}`,
            message: `${label} will be moved to trash.`,
            confirmLabel: 'Delete',
            destructive: true
          })
        ) {
          void trashManyItems(items);
        }
      }
    };

    // Shared view: only offer a batch action when every selected item lives in
    // one editable shared scope. Move-within-scope stays drag-only ("Move to
    // root" would pull items out of the share), so just Delete here.
    if (ctx.source === 'shared') {
      const roots = items.map((item) =>
        itemSharedRootId(item, tree.notesById, tree.collectionsById)
      );
      const root = roots[0];
      const uniformEditable =
        !!root &&
        roots.every((r) => r === root) &&
        !collectionScopeIsReadOnly(root, tree.collectionsById);
      if (!uniformEditable) return [];
      return [deleteBatchItem];
    }

    if (!ctx.canReorganize) return [];

    return [
      {
        label: `Move ${label} to root`,
        onSelect: () => void moveManyTo(items, null)
      },
      'separator',
      deleteBatchItem
    ];
  }

  // The "create a … inside this folder" entries, shared between the Home folder
  // menu and the editable-shared folder menu so the two stay in lockstep.
  function folderCreateMenuItems(id: string): MenuItem[] {
    return [
      {
        label: 'New note in folder',
        onSelect: () => ctx.startDraft('note', id)
      },
      ...(noteTypeEnabled('freeform')
        ? [
            {
              label: 'New drawing canvas in folder',
              onSelect: () => ctx.startDraft('drawing', id)
            }
          ]
        : []),
      ...(noteTypeEnabled('ink')
        ? [
            {
              label: 'New handwritten note in folder',
              onSelect: () => ctx.startDraft('ink', id)
            }
          ]
        : []),
      ...(noteTypeEnabled('pdf')
        ? [
            {
              label: 'Import PDF in folder',
              onSelect: () => ctx.startPdfImport(id)
            }
          ]
        : []),
      ...(noteTypeEnabled('kanban')
        ? [
            {
              label: tUi('nav.create.kanbanInFolder'),
              onSelect: () => ctx.startDraft('kanban', id)
            }
          ]
        : []),
      {
        label: 'New folder inside',
        onSelect: () => ctx.startDraft('folder', id)
      }
    ];
  }

  async function menuItemsForTarget(
    target: MenuTarget
  ): Promise<(MenuItem | 'separator')[]> {
    if (target.kind === 'note') {
      const id = target.id;
      const note = tree.notesById[id];

      // Notes inside the trash get a stripped-down menu.
      if (
        ctx.source === 'trash' ||
        (note && noteIsUnderTrash(note, tree.collectionsById))
      ) {
        return [
          { label: 'Open', onSelect: () => ctx.onOpenNote(id) },
          'separator',
          { label: 'Restore', onSelect: () => void restoreNote(id) },
          {
            label: 'Delete permanently',
            destructive: true,
            onSelect: async () => {
              if (
                await confirm({
                  title: 'Delete permanently',
                  message: `"${note?.title ?? 'this note'}" will be removed. This cannot be undone.`,
                  confirmLabel: 'Delete',
                  destructive: true
                })
              ) {
                void purgeNote(id);
              }
            }
          }
        ];
      }

      const items: (MenuItem | 'separator')[] = [
        { label: 'Open', onSelect: () => ctx.onOpenNote(id) }
      ];
      const openRight = ctx.onOpenNoteRight;
      if (openRight) {
        items.push({
          label: 'Open to the right',
          onSelect: () => openRight(id)
        });
      }
      const openBelow = ctx.onOpenNoteBelow;
      if (openBelow) {
        items.push({
          label: 'Open below',
          onSelect: () => openBelow(id)
        });
      }
      const openInNewWindow = ctx.onOpenInNewWindow;
      if (openInNewWindow) {
        items.push({
          label: 'Open in new window',
          onSelect: () => openInNewWindow(id)
        });
      }
      const exporters =
        note?.note_kind === 'ink' || note?.note_kind === 'pdf'
          ? (await import('$lib/note-exporters')).exportersForNote(note)
          : [];
      if (exporters.length > 0) {
        items.push('separator', {
          label: 'Export',
          children: exporters.map((exporter) => ({
            id: exporter.id,
            label: exporter.label,
            onSelect: () =>
              void ctx.runNoteExporter(id, exporter.label, () =>
                exporter.run(id)
              )
          }))
        });
      }
      if (
        ctx.source === 'shared' ||
        (note && noteIsUnderShared(note, tree.collectionsById))
      ) {
        // Inside an editable shared scope, recipients can rename + delete the
        // note (routed into the scope on the next push). "Move to root" is
        // omitted — it would pull the note out of the share; reorganizing
        // stays drag-only within the scope. Read-only scopes keep the
        // open-only menu built above.
        if (note && ctx.sharedItemEditable({ kind: 'note', id })) {
          items.push(
            'separator',
            {
              label: 'Rename…',
              shortcut: 'F2',
              onSelect: () =>
                ctx.startRename('note', id, note?.title ?? 'Untitled')
            },
            {
              label: 'Delete',
              shortcut: 'Del',
              destructive: true,
              onSelect: () => void trashNote(id)
            }
          );
        }
        return items;
      }
      items.push(
        'separator',
        {
          label: 'Rename…',
          shortcut: 'F2',
          onSelect: () => ctx.startRename('note', id, note?.title ?? 'Untitled')
        },
        { label: 'Move to root', onSelect: () => void moveNoteTo(id, null) },
        'separator',
        {
          label: 'Delete',
          shortcut: 'Del',
          destructive: true,
          onSelect: () => void trashNote(id)
        }
      );
      return items;
    }

    if (target.kind === 'folder') {
      const id = target.id;
      const folder = tree.collectionsById[id];

      // Sub-folders inside trash — restore or purge.
      if (
        ctx.source === 'trash' ||
        collectionIsUnderTrash(id, tree.collectionsById)
      ) {
        return [
          { label: 'Restore', onSelect: () => void restoreCollection(id) },
          {
            label: 'Delete permanently',
            destructive: true,
            onSelect: async () => {
              if (
                await confirm({
                  title: 'Delete folder permanently',
                  message: `Folder "${folder?.name ?? 'this folder'}" and everything inside will be removed. This cannot be undone.`,
                  confirmLabel: 'Delete',
                  destructive: true
                })
              ) {
                void purgeCollection(id);
              }
            }
          }
        ];
      }

      // Shared view: an editable scope lets recipients create inside the folder
      // and (for non-anchor sub-folders) rename/delete it. The shared root anchor
      // itself is structurally read-only — create-inside only, no rename/delete/
      // move/share — but always offers "Leave shared folder" (works at any access
      // level, so a view-only root that would otherwise have no menu still can be
      // left). Read-only sub-folders get no menu.
      if (ctx.source === 'shared') {
        const editable = sharedFolderIsEditable(id, tree.collectionsById);
        if (ctx.isSharedAnchor(id)) {
          const canManageShare = folder
            ? collectionUserCanManageSharing(folder)
            : false;
          const items: (MenuItem | 'separator')[] = editable
            ? [...folderCreateMenuItems(id), 'separator']
            : [];
          if (canManageShare) {
            items.push({
              label: tUi('sharing.menu.group'),
              children: [
                {
                  label: tUi('sharing.menu.shareFolder'),
                  onSelect: () => openCollectionShareDialog(id, 'invite')
                },
                {
                  label: tUi('sharing.menu.manageAccess'),
                  onSelect: () => openCollectionShareDialog(id, 'access')
                }
              ]
            });
            items.push('separator');
          }
          items.push({
            label: tUi('sharing.menu.leaveFolder'),
            destructive: true,
            onSelect: () => void ctx.leaveShared(id)
          });
          return items;
        }
        if (!editable) return [];
        return [
          ...folderCreateMenuItems(id),
          'separator',
          {
            label: 'Rename folder…',
            shortcut: 'F2',
            onSelect: () =>
              ctx.startRename('folder', id, folder?.name ?? 'Folder')
          },
          {
            label: 'Delete',
            shortcut: 'Del',
            destructive: true,
            onSelect: () => void trashCollection(id)
          }
        ];
      }

      if (!ctx.canCreate) return [];

      return [
        ...folderCreateMenuItems(id),
        'separator',
        {
          label: 'Rename folder…',
          shortcut: 'F2',
          onSelect: () =>
            ctx.startRename('folder', id, folder?.name ?? 'Folder')
        },
        {
          label: 'Move to root',
          onSelect: () => void moveCollectionTo(id, null)
        },
        ...sharingMenuGroup(id, folder),
        'separator',
        {
          label: 'Delete',
          shortcut: 'Del',
          destructive: true,
          onSelect: () => void trashCollection(id)
        }
      ];
    }

    if (ctx.source === 'trash') {
      return [
        {
          label: `Empty trash (${ctx.trashItemCount})`,
          destructive: true,
          disabled: ctx.trashItemCount === 0 || ctx.emptyTrashPending,
          onSelect: () => void ctx.startEmptyTrash()
        }
      ];
    }

    if (!ctx.canCreate) return [];

    return [
      { label: 'New note', onSelect: () => ctx.startDraft('note', null) },
      ...(noteTypeEnabled('freeform')
        ? [
            {
              label: 'New drawing canvas',
              onSelect: () => ctx.startDraft('drawing', null)
            }
          ]
        : []),
      ...(noteTypeEnabled('ink')
        ? [
            {
              label: 'New handwritten note',
              onSelect: () => ctx.startDraft('ink', null)
            }
          ]
        : []),
      ...(noteTypeEnabled('pdf')
        ? [{ label: 'Import PDF', onSelect: () => ctx.startPdfImport(null) }]
        : []),
      ...(noteTypeEnabled('kanban')
        ? [
            {
              label: tUi('nav.create.kanban'),
              onSelect: () => ctx.startDraft('kanban', null)
            }
          ]
        : []),
      { label: 'New folder', onSelect: () => ctx.startDraft('folder', null) }
    ];
  }

  return { menuItemsForTarget, menuItemsForBatch, folderCreateMenuItems };
}
