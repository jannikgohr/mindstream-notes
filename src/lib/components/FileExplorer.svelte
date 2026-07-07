<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    ChevronRight,
    Feather,
    FileText,
    Folder,
    FolderOpen,
    FolderPlus,
    FileUp,
    PencilRuler,
    FilePlus2,
    Trash2
  } from '@lucide/svelte';
  import FavouriteStar from './FavouriteStar.svelte';
  import { noteKindIcon } from './note-kind-icon';
  import { tooltip } from '$lib/actions/tooltip';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Separator } from '$lib/components/ui/separator';
  import ContextMenu from './ContextMenu.svelte';
  import type { MenuItem } from './context-menu-types';
  import { alert, confirm } from './confirm-dialog.svelte';
  import SortControl from './SortControl.svelte';
  import { sortTree } from '$lib/sort';
  import {
    tree,
    createCollectionIn,
    createNoteIn,
    emptyTrash,
    importPdfIn,
    moveManyTo,
    moveCollectionTo,
    moveNoteTo,
    purgeMany as purgeManyItems,
    purgeCollection,
    purgeNote,
    renameCollection,
    renameNote,
    restoreMany as restoreManyItems,
    restoreCollection,
    restoreNote,
    setNoteFavourite,
    trashMany as trashManyItems,
    trashCollection,
    trashNote
  } from '$lib/stores/tree.svelte';
  import { setSortDirection, setSortStrategy, ui } from '$lib/state.svelte';
  import { i18n, tUi } from '$lib/settings/i18n.svelte';
  import type { TreeNode } from '$lib/api';
  import {
    collectionIsUnderTrash,
    nodesForDesktopSource,
    noteIsUnderShared,
    noteIsUnderTrash,
    type DesktopNoteSource
  } from '$lib/stores/note-source.svelte';
  import {
    FILE_EXPLORER_SOURCES,
    defaultDraftText,
    dragPayloadFromTransfer,
    draftKindToNoteKind,
    emptyStateMessageForSource,
    dragItemsForStart,
    nodeKey,
    selectedItemsFromKeys,
    selectionKeyForItem,
    updateSelectionForClick,
    visibleSelectionKeys,
    type Draft,
    type DraftKind,
    type Drag,
    type MenuTarget,
    type Rename,
    type SelectionKey,
    type TreeItemRef
  } from './file-explorer-helpers';

  interface Props {
    source?: DesktopNoteSource;
    onSourceChange?: (source: DesktopNoteSource) => void;
    onOpenNote: (id: string) => void;
    onOpenNoteRight?: (id: string) => void;
    onOpenNoteBelow?: (id: string) => void;
    onOpenInNewWindow?: (id: string) => void;
  }
  let {
    source = 'home',
    onSourceChange,
    onOpenNote,
    onOpenNoteRight,
    onOpenNoteBelow,
    onOpenInNewWindow
  }: Props = $props();

  let expanded = $state<Record<string, boolean>>({});

  const sortedTree = $derived(
    sortTree(
      tree.tree,
      ui.sortStrategy,
      { notesById: tree.notesById },
      ui.sortDirection
    )
  );

  const sourceNodes = $derived(
    nodesForDesktopSource(
      source,
      sortedTree,
      tree.notesById,
      tree.collectionsById
    )
  );
  const canCreate = $derived(source === 'home');
  const canReorganize = $derived(source === 'home');
  const trashItemCount = $derived(source === 'trash' ? sourceNodes.length : 0);

  // ---------- Inline draft entry (replaces window.prompt) ----------
  // 'note' = markdown note, 'drawing' = freeform note, 'ink' =
  // native ink note. They share the draft / commit code path because
  // the only difference at the data layer is the note_kind we pass to
  // createNoteIn; the UX (inline input for the title) is identical.
  let draft = $state<Draft | null>(null);
  let rename = $state<Rename | null>(null);
  let nameInput = $state<HTMLInputElement | null>(null);
  let pdfInput = $state<HTMLInputElement | null>(null);
  let pdfImportParentId = $state<string | null>(null);
  let emptyTrashPending = $state(false);
  let emptyTrashAnimation = $state(0);
  let emptyTrashParticleCount = $state(0);
  let deleteConfirmId = $state<string | null>(null);
  let explorerRoot = $state<HTMLElement | null>(null);
  let sourceChipRow = $state<HTMLElement | null>(null);
  let sourceChipsCollapsed = $state(false);
  let expandedSourceChipWidth = 0;
  let toolbarRow = $state<HTMLElement | null>(null);
  let sortControlCollapsed = $state(false);
  let expandedToolbarWidth = 0;
  let selectedKeys = $state<SelectionKey[]>([]);
  let selectionAnchor = $state<SelectionKey | null>(null);
  let activeKey = $state<SelectionKey | null>(null);

  const selectedKeySet = $derived(new Set(selectedKeys));
  const selectedCount = $derived(selectedKeys.length);
  let selectedSource = $state<DesktopNoteSource | null>(null);

  function clearFileTreeInteractionState(blurFocusedControl = false) {
    selectedKeys = [];
    selectionAnchor = null;
    activeKey = null;
    if (!blurFocusedControl || !explorerRoot) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && explorerRoot.contains(active)) {
      active.blur();
    }
  }

  $effect(() => {
    if (!nameInput) return;
    queueMicrotask(() => {
      nameInput?.focus();
      nameInput?.select();
    });
  });

  $effect(() => {
    if (selectedSource === null) {
      selectedSource = source;
      return;
    }
    if (selectedSource === source) return;
    selectedSource = source;
    clearFileTreeInteractionState();
  });

  function startDraft(kind: DraftKind, parentId: string | null) {
    if (!canCreate) return;
    if (parentId) expanded[parentId] = true;
    draft = { kind, parentId, text: defaultDraftText(kind) };
  }
  function startPdfImport(parentId: string | null) {
    if (!canCreate) return;
    pdfImportParentId = parentId;
    if (pdfInput) pdfInput.value = '';
    pdfInput?.click();
  }
  async function onPdfPicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const id = await importPdfIn(pdfImportParentId, file);
    pdfImportParentId = null;
    onOpenNote(id);
  }
  function cancelDraft() {
    draft = null;
  }
  async function commitDraft() {
    if (!draft) return;
    const text = draft.text.trim();
    if (!text) {
      draft = null;
      return;
    }
    const { kind, parentId } = draft;
    draft = null;
    const noteKind = draftKindToNoteKind(kind);
    if (noteKind) {
      const id = await createNoteIn(parentId, text, noteKind);
      onOpenNote(id);
    } else {
      await createCollectionIn(parentId, text);
    }
  }
  function onDraftKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitDraft();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelDraft();
    }
  }
  function onDraftBlur() {
    setTimeout(() => {
      if (!draft) return;
      if (!draft.text.trim()) cancelDraft();
      else void commitDraft();
    }, 0);
  }

  function startRename(kind: 'note' | 'folder', id: string, current: string) {
    rename = { kind, id, new_name: current };
  }
  function cancelRename() {
    rename = null;
  }
  async function commitRename() {
    if (!rename) return;
    const next = rename.new_name.trim();
    if (!next) {
      rename = null;
      return;
    }
    const { kind, id } = rename;
    rename = null;
    if (kind === 'note') await renameNote(id, next);
    else await renameCollection(id, next);
  }
  function onRenameKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  }
  function onRenameBlur() {
    setTimeout(() => {
      if (!rename) return;
      if (!rename.new_name.trim()) cancelRename();
      else void commitRename();
    }, 0);
  }

  // ---------- Context menu ----------
  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let menuTarget = $state<MenuTarget | null>(null);
  let currentMenuItems = $state<(MenuItem | 'separator')[]>([]);
  let menuToken = 0;

  async function openMenu(e: MouseEvent, target: MenuTarget) {
    e.preventDefault();
    e.stopPropagation();
    selectTargetForContextMenu(target);
    const token = ++menuToken;
    const batchItems = selectedItemsForTarget(target);
    const items =
      batchItems.length > 1
        ? await menuItemsForBatch(batchItems)
        : target.kind === 'root' && !canCreate && source !== 'trash'
          ? []
          : await menuItemsForTarget(target);
    if (token !== menuToken) return;
    if (items.length === 0) return;
    menuX = e.clientX;
    menuY = e.clientY;
    menuTarget = target;
    currentMenuItems = items;
    menuOpen = true;
  }
  function closeMenu() {
    menuToken += 1;
    menuOpen = false;
    menuTarget = null;
    currentMenuItems = [];
  }

  async function runNoteExporter(
    id: string,
    label: string,
    run: () => Promise<void>
  ) {
    try {
      await run();
    } catch (err) {
      console.error('[FileExplorer] note export failed', id, err);
      await alert({
        title: `${label} export failed`,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  async function startEmptyTrash() {
    if (emptyTrashPending || trashItemCount === 0) return;
    if (
      await confirm({
        title: 'Empty trash',
        message: `${trashItemCount} item(s) will be removed permanently. This cannot be undone.`,
        confirmLabel: 'Empty trash',
        destructive: true
      })
    ) {
      emptyTrashPending = true;
      try {
        const removed = await emptyTrash();
        const removedCount = removed.notes + removed.folders;
        if (removedCount > 0) {
          emptyTrashParticleCount = Math.min(removedCount, 6);
          emptyTrashAnimation += 1;
        }
      } finally {
        emptyTrashPending = false;
      }
    }
  }

  function startDelete(id: string) {
    deleteConfirmId = id;
  }

  function cancelDelete() {
    deleteConfirmId = null;
  }

  async function commitDelete(id: string) {
    deleteConfirmId = null;
    await trashNote(id);
  }

  function selectNodeFromClick(e: MouseEvent, node: TreeNode): boolean {
    const key = nodeKey(node) as SelectionKey;
    const result = updateSelectionForClick(
      selectedKeys,
      key,
      visibleSelectionKeys(sourceNodes, expanded),
      selectionAnchor,
      activeKey,
      {
        toggle: e.ctrlKey || e.metaKey,
        range: e.shiftKey
      }
    );
    selectedKeys = result.selected;
    selectionAnchor = result.anchor;
    activeKey = result.active;
    return e.ctrlKey || e.metaKey || e.shiftKey;
  }

  function selectTargetForContextMenu(target: MenuTarget) {
    if (target.kind === 'root') return;
    const key = selectionKeyForItem(target);
    if (selectedKeySet.has(key)) return;
    selectedKeys = [key];
    selectionAnchor = key;
    activeKey = key;
  }

  function selectedItemsForTarget(target: MenuTarget): TreeItemRef[] {
    if (target.kind === 'root') return [];
    const key = selectionKeyForItem(target);
    if (selectedKeySet.has(key) && selectedCount > 1) {
      return selectedItemsFromKeys(selectedKeys);
    }
    return [target];
  }

  function batchLabel(items: TreeItemRef[]): string {
    return `${items.length} item${items.length === 1 ? '' : 's'}`;
  }

  async function menuItemsForBatch(
    items: TreeItemRef[]
  ): Promise<(MenuItem | 'separator')[]> {
    if (items.length <= 1) return [];
    const label = batchLabel(items);

    if (source === 'trash') {
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

    if (!canReorganize) return [];

    return [
      {
        label: `Move ${label} to root`,
        onSelect: () => void moveManyTo(items, null)
      },
      'separator',
      {
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
        source === 'trash' ||
        (note && noteIsUnderTrash(note, tree.collectionsById))
      ) {
        return [
          { label: 'Open', onSelect: () => onOpenNote(id) },
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
        { label: 'Open', onSelect: () => onOpenNote(id) }
      ];
      if (onOpenNoteRight) {
        items.push({
          label: 'Open to the right',
          onSelect: () => onOpenNoteRight(id)
        });
      }
      if (onOpenNoteBelow) {
        items.push({
          label: 'Open below',
          onSelect: () => onOpenNoteBelow(id)
        });
      }
      if (onOpenInNewWindow) {
        items.push({
          label: 'Open in new window',
          onSelect: () => onOpenInNewWindow(id)
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
              void runNoteExporter(id, exporter.label, () => exporter.run(id))
          }))
        });
      }
      if (
        source === 'shared' ||
        (note && noteIsUnderShared(note, tree.collectionsById))
      ) {
        return items;
      }
      items.push(
        'separator',
        {
          label: 'Rename…',
          shortcut: 'F2',
          onSelect: () => startRename('note', id, note?.title ?? 'Untitled')
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
        source === 'trash' ||
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

      if (!canCreate) return [];

      return [
        { label: 'New note in folder', onSelect: () => startDraft('note', id) },
        {
          label: 'New drawing canvas in folder',
          onSelect: () => startDraft('drawing', id)
        },
        {
          label: 'New handwritten note in folder',
          onSelect: () => startDraft('ink', id)
        },
        { label: 'Import PDF in folder', onSelect: () => startPdfImport(id) },
        {
          label: 'New folder inside',
          onSelect: () => startDraft('folder', id)
        },
        'separator',
        {
          label: 'Rename folder…',
          shortcut: 'F2',
          onSelect: () => startRename('folder', id, folder?.name ?? 'Folder')
        },
        {
          label: 'Move to root',
          onSelect: () => void moveCollectionTo(id, null)
        },
        'separator',
        {
          label: 'Delete',
          shortcut: 'Del',
          destructive: true,
          onSelect: () => void trashCollection(id)
        }
      ];
    }

    if (source === 'trash') {
      return [
        {
          label: `Empty trash (${trashItemCount})`,
          destructive: true,
          disabled: trashItemCount === 0 || emptyTrashPending,
          onSelect: () => void startEmptyTrash()
        }
      ];
    }

    if (!canCreate) return [];

    return [
      { label: 'New note', onSelect: () => startDraft('note', null) },
      {
        label: 'New drawing canvas',
        onSelect: () => startDraft('drawing', null)
      },
      {
        label: 'New handwritten note',
        onSelect: () => startDraft('ink', null)
      },
      { label: 'Import PDF', onSelect: () => startPdfImport(null) },
      { label: 'New folder', onSelect: () => startDraft('folder', null) }
    ];
  }

  // ---------- Drag and drop ----------
  let drag = $state<Drag>(null);
  let dragOver = $state<string | null>(null);

  function setDragPayload(e: DragEvent, item: TreeItemRef): Drag {
    if (!e.dataTransfer) return null;
    const items = dragItemsForStart(item, selectedKeys);
    const key = selectionKeyForItem(item);
    if (!selectedKeySet.has(key)) {
      selectedKeys = [key];
      selectionAnchor = key;
      activeKey = key;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-tree-items', JSON.stringify(items));
    if (item.kind === 'note') {
      e.dataTransfer.setData('application/x-note-id', item.id);
    } else {
      e.dataTransfer.setData('application/x-folder-id', item.id);
    }
    e.dataTransfer.setData('text/plain', item.id);
    return { ...item, items };
  }

  function onNoteDragStart(e: DragEvent, noteId: string) {
    if (!canReorganize) return;
    if (!e.dataTransfer) return;
    drag = setDragPayload(e, { kind: 'note', id: noteId });
  }
  function onFolderDragStart(e: DragEvent, folderId: string) {
    if (!canReorganize) return;
    if (!e.dataTransfer) return;
    e.stopPropagation();
    drag = setDragPayload(e, { kind: 'folder', id: folderId });
  }
  function onDragEnd() {
    drag = null;
    dragOver = null;
  }
  function canDropOnFolder(targetFolderId: string | null): boolean {
    if (!canReorganize) return false;
    if (!drag) return true;
    const items = drag.items ?? [drag];
    return !items.some(
      (item) => item.kind === 'folder' && targetFolderId === item.id
    );
  }
  function onDragOverFolder(e: DragEvent, folderId: string) {
    if (!e.dataTransfer) return;
    if (!canDropOnFolder(folderId)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    dragOver = `f:${folderId}`;
  }
  function onDragOverRoot(e: DragEvent) {
    if (!canReorganize) return;
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dragOver = 'root';
  }
  function onDragOverNote(e: DragEvent, noteId: string) {
    if (!canReorganize) return;
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dragOver = `n:${noteId}`;
  }
  function onDragLeave() {
    dragOver = null;
  }
  function readPayload(e: DragEvent): Drag {
    return dragPayloadFromTransfer(e.dataTransfer);
  }
  function payloadItems(payload: Drag): TreeItemRef[] {
    if (!payload) return [];
    return payload.items ?? [{ kind: payload.kind, id: payload.id }];
  }
  async function onDropOnFolder(e: DragEvent, targetFolderId: string) {
    e.preventDefault();
    e.stopPropagation();
    const payload = readPayload(e);
    dragOver = null;
    drag = null;
    if (!payload) return;
    await moveManyTo(payloadItems(payload), targetFolderId);
  }
  async function onDropOnRoot(e: DragEvent) {
    if (!canReorganize) return;
    e.preventDefault();
    const payload = readPayload(e);
    dragOver = null;
    drag = null;
    if (!payload) return;
    await moveManyTo(payloadItems(payload), null);
  }

  function toggleFolder(id: string) {
    expanded[id] = !expanded[id];
  }
  function emptyStateMessage(): string {
    return emptyStateMessageForSource(source, tUi('fileTree.emptyRoot'));
  }

  function onTreePointerDown(e: PointerEvent) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-file-tree-node], button, input')) return;
    clearFileTreeInteractionState(true);
  }

  function updateSourceChipCollapse() {
    if (!sourceChipRow) return;
    if (!sourceChipsCollapsed) {
      expandedSourceChipWidth = sourceChipRow.scrollWidth;
    }
    const needed = expandedSourceChipWidth || sourceChipRow.scrollWidth;
    sourceChipsCollapsed = needed > sourceChipRow.clientWidth;
  }

  function updateSortControlCollapse() {
    if (!toolbarRow) return;
    if (!sortControlCollapsed) {
      expandedToolbarWidth = toolbarRow.scrollWidth;
    }
    const needed = expandedToolbarWidth || toolbarRow.scrollWidth;
    sortControlCollapsed = needed > toolbarRow.clientWidth;
  }

  onMount(() => {
    const sourceObserver = new ResizeObserver(() => updateSourceChipCollapse());
    const toolbarObserver = new ResizeObserver(() =>
      updateSortControlCollapse()
    );
    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (explorerRoot?.contains(target)) return;
      clearFileTreeInteractionState(true);
    };
    if (sourceChipRow) sourceObserver.observe(sourceChipRow);
    if (toolbarRow) toolbarObserver.observe(toolbarRow);
    document.addEventListener('pointerdown', onDocumentPointerDown, {
      capture: true
    });
    requestAnimationFrame(() => {
      updateSourceChipCollapse();
      updateSortControlCollapse();
    });
    return () => {
      sourceObserver.disconnect();
      toolbarObserver.disconnect();
      document.removeEventListener('pointerdown', onDocumentPointerDown, {
        capture: true
      });
    };
  });

  $effect(() => {
    void source;
    void sourceChipRow;
    void toolbarRow;
    void i18n.language;
    void ui.sortStrategy;
    void ui.sortDirection;
    sourceChipsCollapsed = false;
    expandedSourceChipWidth = 0;
    sortControlCollapsed = false;
    expandedToolbarWidth = 0;
    void tick().then(() =>
      requestAnimationFrame(() => {
        updateSourceChipCollapse();
        updateSortControlCollapse();
      })
    );
  });
</script>

<aside
  bind:this={explorerRoot}
  class="flex h-full w-full flex-col bg-card text-sm"
  oncontextmenu={(e) => openMenu(e, { kind: 'root' })}
>
  <div
    bind:this={toolbarRow}
    class="flex items-center justify-between gap-2 overflow-hidden px-3 py-1.5"
  >
    <SortControl
      strategy={ui.sortStrategy}
      direction={ui.sortDirection}
      onStrategyChange={setSortStrategy}
      onDirectionChange={setSortDirection}
      onLabelOverflowChange={(overflowing) => {
        if (overflowing) sortControlCollapsed = true;
      }}
      variant="ghost"
      compact
      collapsed={sortControlCollapsed}
    />
    {#if canCreate}
      <div class="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onclick={() => startDraft('folder', null)}
          title={tUi('fileTree.newFolder')}
          aria-label={tUi('fileTree.newFolder')}
          class="size-7"
        >
          <FolderPlus class="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onclick={() => startDraft('drawing', null)}
          title={tUi('fileTree.newDrawing')}
          aria-label={tUi('fileTree.newDrawing')}
          class="size-7"
        >
          <PencilRuler class="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onclick={() => startDraft('ink', null)}
          title={tUi('fileTree.newInk')}
          aria-label={tUi('fileTree.newInk')}
          class="size-7"
        >
          <Feather class="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onclick={() => startPdfImport(null)}
          title={tUi('fileTree.importPdf')}
          aria-label={tUi('fileTree.importPdf')}
          class="size-7"
        >
          <FileUp class="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onclick={() => startDraft('note', null)}
          title={tUi('fileTree.newNote')}
          aria-label={tUi('fileTree.newNote')}
          class="size-7"
        >
          <FilePlus2 class="size-3.5" />
        </Button>
      </div>
    {:else if source === 'trash'}
      <Button
        variant="ghost"
        size="sm"
        onclick={() => void startEmptyTrash()}
        disabled={trashItemCount === 0 || emptyTrashPending}
        title="Empty trash"
        aria-label="Empty trash"
        class="relative h-7 shrink-0 overflow-hidden px-2 text-xs text-destructive hover:text-destructive"
      >
        {#if emptyTrashAnimation > 0}
          {#key emptyTrashAnimation}
            <span class="trash-suck-particles" aria-hidden="true">
              {#each Array.from({ length: emptyTrashParticleCount }) as _, i}
                <span
                  class="trash-suck-particle"
                  style="--i: {i}; --x: {(i -
                    (emptyTrashParticleCount - 1) / 2) *
                    5}px;"
                ></span>
              {/each}
            </span>
          {/key}
        {/if}
        <Trash2 class="size-3.5" />
        Empty
      </Button>
    {/if}
  </div>

  <nav
    bind:this={sourceChipRow}
    class="source-chip-row flex shrink-0 gap-1 overflow-hidden px-3 pb-2"
    class:source-chip-row-collapsed={sourceChipsCollapsed}
    aria-label={tUi('nav.primary')}
    oncontextmenu={(e) => {
      e.preventDefault();
      e.stopPropagation();
    }}
  >
    {#each FILE_EXPLORER_SOURCES as item (item.id)}
      {@const active = source === item.id}
      {@const Icon = item.icon}
      {@const label = tUi(item.labelKey)}
      <button
        type="button"
        class="source-chip inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors {active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground'}"
        class:source-chip-active={active}
        use:tooltip={active ? undefined : label}
        aria-current={active ? 'page' : undefined}
        aria-label={label}
        onclick={() => onSourceChange?.(item.id)}
      >
        <Icon class="size-3.5 shrink-0" />
        <span class="source-chip-label truncate">{label}</span>
      </button>
    {/each}
  </nav>

  <Separator />

  <div
    role="group"
    aria-label={tUi('fileTree.tree')}
    class="flex-1 overflow-y-auto px-1 pb-2 pt-3"
    class:ring-1={dragOver === 'root'}
    class:ring-ring={dragOver === 'root'}
    ondragover={onDragOverRoot}
    ondragleave={onDragLeave}
    ondrop={onDropOnRoot}
    onpointerdown={onTreePointerDown}
  >
    {#if tree.error}
      <p class="px-2 py-3 text-xs text-destructive">
        {tUi('fileTree.error')}: {tree.error}
      </p>
    {:else if !tree.ready}
      <p class="px-2 py-3 text-xs text-muted-foreground">
        {tUi('fileTree.loading')}
      </p>
    {:else if sourceNodes.length === 0 && !draft}
      <p class="px-2 py-3 text-xs text-muted-foreground">
        {emptyStateMessage()}
      </p>
    {/if}

    {#each sourceNodes as node (nodeKey(node))}
      {@render renderNode(node)}
    {/each}

    {#if canCreate && draft && draft.parentId === null}
      {@render renderDraft()}
    {/if}
  </div>
</aside>

<input
  bind:this={pdfInput}
  class="hidden"
  type="file"
  accept="application/pdf,.pdf"
  onchange={(e) => void onPdfPicked(e)}
/>

{#snippet renderDraft()}
  {@const kind = draft?.kind ?? 'note'}
  {@const placeholder =
    kind === 'folder'
      ? tUi('fileTree.newFolder')
      : kind === 'drawing'
        ? tUi('fileTree.newDrawing')
        : kind === 'ink'
          ? tUi('fileTree.newInk')
          : tUi('fileTree.newNote')}
  <div class="my-0.5 flex items-center gap-1.5 rounded-md px-2 py-0.5">
    {#if kind === 'folder'}
      <Folder class="size-3.5 shrink-0 text-muted-foreground" />
    {:else if kind === 'drawing'}
      <PencilRuler class="size-3.5 shrink-0 text-muted-foreground" />
    {:else if kind === 'ink'}
      <Feather class="size-3.5 shrink-0 text-muted-foreground" />
    {:else}
      <FileText class="size-3.5 shrink-0 text-muted-foreground" />
    {/if}
    <Input
      bind:ref={nameInput}
      bind:value={draft!.text}
      {placeholder}
      class="h-7 px-2 text-sm"
      onkeydown={onDraftKey}
      onblur={onDraftBlur}
    />
  </div>
{/snippet}

{#snippet renderRenameInput()}
  <Input
    bind:ref={nameInput}
    bind:value={rename!.new_name}
    class="h-6 px-1.5 text-sm"
    onkeydown={onRenameKey}
    onblur={onRenameBlur}
  />
{/snippet}

{#snippet renderNode(node: TreeNode)}
  {#if node.kind === 'folder'}
    {@const isOver = dragOver === `f:${node.id}`}
    {@const isSelected = selectedKeySet.has(nodeKey(node) as SelectionKey)}
    {@const renaming =
      rename && rename.kind === 'folder' && rename.id === node.id}
    <button
      data-file-tree-node
      type="button"
      draggable={canReorganize}
      class="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left ring-offset-background hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      class:bg-accent={isOver || isSelected}
      class:opacity-60={drag?.kind === 'folder' && drag.id === node.id}
      onclick={(e) => {
        const modified = selectNodeFromClick(e, node);
        if (!modified) toggleFolder(node.id);
      }}
      oncontextmenu={(e) => openMenu(e, { kind: 'folder', id: node.id })}
      ondragstart={(e) => onFolderDragStart(e, node.id)}
      ondragend={onDragEnd}
      ondragover={(e) => onDragOverFolder(e, node.id)}
      ondragleave={onDragLeave}
      ondrop={(e) => onDropOnFolder(e, node.id)}
    >
      <ChevronRight
        class={`size-3.5 shrink-0 transition-transform ${expanded[node.id] ? 'rotate-90' : ''}`}
      />
      {#if expanded[node.id]}
        <FolderOpen class="size-3.5 shrink-0 text-muted-foreground" />
      {:else}
        <Folder class="size-3.5 shrink-0 text-muted-foreground" />
      {/if}
      {#if renaming}
        {@render renderRenameInput()}
      {:else}
        <span class="truncate">{node.name}</span>
      {/if}
    </button>
    {#if expanded[node.id]}
      <div class="ml-3 border-l border-border pl-1">
        {#each node.children as child (nodeKey(child))}
          {@render renderNode(child)}
        {/each}
        {#if canCreate && draft && draft.parentId === node.id}
          {@render renderDraft()}
        {/if}
      </div>
    {/if}
  {:else}
    {@const isOver = dragOver === `n:${node.id}`}
    {@const isSelected = selectedKeySet.has(nodeKey(node) as SelectionKey)}
    {@const renaming =
      rename && rename.kind === 'note' && rename.id === node.id}
    {@const note = tree.notesById[node.id]}
    {@const fav = note?.favourite === true}
    {@const inTrash =
      source === 'trash' ||
      (note ? noteIsUnderTrash(note, tree.collectionsById) : false)}
    {@const canDelete =
      !inTrash &&
      source !== 'shared' &&
      (note ? !noteIsUnderShared(note, tree.collectionsById) : true)}
    {@const kind = note?.note_kind}
    {@const NoteIcon = noteKindIcon(kind)}
    <!-- Row uses a flex container so the favourite-toggle button can
         sit alongside the primary open-note tap target without nesting
         <button>s. The drag handlers live on the wrapper so users can
         start a drag from either side; only the main button responds
         to click + contextmenu. -->
    <div
      data-file-tree-node
      role="group"
      draggable={canReorganize}
      class="file-tree-note-row group flex w-full items-center gap-0.5 rounded-md pr-1 hover:bg-accent hover:text-accent-foreground"
      class:bg-accent={isOver || isSelected}
      class:opacity-60={drag?.kind === 'note' && drag.id === node.id}
      ondragstart={(e) => onNoteDragStart(e, node.id)}
      ondragend={onDragEnd}
      ondragover={(e) => onDragOverNote(e, node.id)}
      ondragleave={onDragLeave}
    >
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left focus-visible:outline-none"
        onclick={(e) => {
          const modified = selectNodeFromClick(e, node);
          if (!modified) onOpenNote(node.id);
        }}
        oncontextmenu={(e) => openMenu(e, { kind: 'note', id: node.id })}
      >
        <NoteIcon class="size-3.5 shrink-0 text-muted-foreground" />
        {#if renaming}
          {@render renderRenameInput()}
        {:else}
          <span class="truncate">{node.name}</span>
        {/if}
      </button>
      {#if !inTrash}
        <button
          type="button"
          class="shrink-0 rounded p-1 text-muted-foreground transition-opacity hover:text-foreground {fav
            ? 'opacity-100'
            : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}"
          onclick={() => void setNoteFavourite(node.id, !fav)}
          use:tooltip={fav ? tUi('favourite.remove') : tUi('favourite.add')}
          aria-pressed={fav}
          aria-label={fav ? tUi('favourite.remove') : tUi('favourite.add')}
        >
          <FavouriteStar size={14} favourited={fav} />
        </button>
      {/if}
      {#if canDelete}
        {#if deleteConfirmId === node.id}
          <div class="flex shrink-0 items-center gap-1 pl-1">
            <Button
              variant="destructive"
              size="sm"
              class="h-7 px-2 text-xs"
              onclick={() => void commitDelete(node.id)}
            >
              {tUi('fileTree.deleteTrash.confirm')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="h-7 px-2 text-xs"
              onclick={cancelDelete}
            >
              {tUi('fileTree.delete.cancel')}
            </Button>
          </div>
        {:else}
          <button
            type="button"
            class="shrink-0 rounded p-1 text-muted-foreground transition-opacity hover:text-destructive {deleteConfirmId ===
            node.id
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}"
            onclick={() => startDelete(node.id)}
            use:tooltip={tUi('fileTree.delete')}
            aria-label={tUi('fileTree.delete')}
          >
            <Trash2 size={14} />
          </button>
        {/if}
      {/if}
    </div>
  {/if}
{/snippet}

{#if menuOpen}
  <ContextMenu
    x={menuX}
    y={menuY}
    items={currentMenuItems}
    onClose={closeMenu}
  />
{/if}

<style>
  .source-chip-row-collapsed .source-chip:not(.source-chip-active) {
    width: 1.75rem;
    justify-content: center;
    padding-inline: 0;
  }

  .source-chip-row-collapsed
    .source-chip:not(.source-chip-active)
    .source-chip-label {
    display: none;
  }

  .source-chip-row-collapsed .source-chip.source-chip-active {
    min-width: 0;
    flex: 1 1 auto;
  }

  .file-tree-note-row:has(:focus-visible) {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  .trash-suck-particles {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .trash-suck-particle {
    position: absolute;
    left: calc(50% + var(--x));
    top: 70%;
    width: 3px;
    height: 3px;
    border-radius: 999px;
    background: currentColor;
    opacity: 0;
    animation: trash-suck 520ms cubic-bezier(0.2, 0.85, 0.25, 1) forwards;
    animation-delay: calc(var(--i) * 35ms);
  }

  @keyframes trash-suck {
    0% {
      opacity: 0;
      transform: translate(-18px, -8px) scale(0.9);
    }
    20% {
      opacity: 0.8;
    }
    100% {
      opacity: 0;
      transform: translate(0, -1px) scale(0.15);
    }
  }

  /* `html.reduce-motion` already folds in the OS preference — see
   * src/lib/reduce-motion.svelte.ts. */
  :global(.reduce-motion) .trash-suck-particle {
    animation: none;
  }
</style>
