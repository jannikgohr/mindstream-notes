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
    Home,
    PencilRuler,
    FilePlus2,
    Share2,
    Star,
    Trash2
  } from '@lucide/svelte';
  import FavouriteStar from './FavouriteStar.svelte';
  import { noteKindIcon } from './note-kind-icon';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Separator } from '$lib/components/ui/separator';
  import ContextMenu from './ContextMenu.svelte';
  import type { MenuItem } from './context-menu-types';
  import type { IconComponent } from '$lib/settings/icons';
  import { alert, confirm } from './confirm-dialog.svelte';
  import SortControl from './SortControl.svelte';
  import { sortTree } from '$lib/sort';
  import {
    tree,
    createCollectionIn,
    createNoteIn,
    emptyTrash,
    importPdfIn,
    moveCollectionTo,
    moveNoteTo,
    purgeCollection,
    purgeNote,
    renameCollection,
    renameNote,
    restoreCollection,
    restoreNote,
    setNoteFavourite,
    trashCollection,
    trashNote
  } from '$lib/stores/tree.svelte';
  import { setSortDirection, setSortStrategy, ui } from '$lib/state.svelte';
  import { i18n, tUi } from '$lib/settings/i18n.svelte';
  import type { TreeNode } from '$lib/api';
  import { exportersForNote } from '$lib/note-exporters';
  import {
    collectionIsUnderTrash,
    nodesForDesktopSource,
    noteIsUnderShared,
    noteIsUnderTrash,
    type DesktopNoteSource
  } from '$lib/stores/note-source.svelte';

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

  const SOURCES: {
    id: DesktopNoteSource;
    labelKey: string;
    icon: IconComponent;
  }[] = [
    {
      id: 'home',
      labelKey: 'nav.home',
      icon: Home as unknown as IconComponent
    },
    {
      id: 'favourites',
      labelKey: 'nav.favourite',
      icon: Star as unknown as IconComponent
    },
    {
      id: 'shared',
      labelKey: 'nav.shared',
      icon: Share2 as unknown as IconComponent
    },
    {
      id: 'trash',
      labelKey: 'nav.trash',
      icon: Trash2 as unknown as IconComponent
    }
  ];

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
  type DraftKind = 'note' | 'folder' | 'drawing' | 'ink';
  type Draft = {
    kind: DraftKind;
    parentId: string | null;
    text: string;
  };
  type Rename = {
    kind: 'note' | 'folder';
    id: string;
    new_name: string;
  };

  let draft = $state<Draft | null>(null);
  let rename = $state<Rename | null>(null);
  let nameInput = $state<HTMLInputElement | null>(null);
  let pdfInput = $state<HTMLInputElement | null>(null);
  let pdfImportParentId = $state<string | null>(null);
  let emptyTrashPending = $state(false);
  let sourceChipRow = $state<HTMLElement | null>(null);
  let sourceChipsCollapsed = $state(false);
  let expandedSourceChipWidth = 0;

  $effect(() => {
    if (!nameInput) return;
    queueMicrotask(() => {
      nameInput?.focus();
      nameInput?.select();
    });
  });

  function startDraft(kind: DraftKind, parentId: string | null) {
    if (!canCreate) return;
    if (parentId) expanded[parentId] = true;
    const defaultText =
      kind === 'folder'
        ? 'Untitled folder'
        : kind === 'drawing'
          ? 'Untitled drawing canvas'
          : kind === 'ink'
            ? 'Untitled handwritten note'
            : 'Untitled';
    draft = { kind, parentId, text: defaultText };
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
    if (kind === 'note' || kind === 'drawing' || kind === 'ink') {
      const id = await createNoteIn(
        parentId,
        text,
        kind === 'drawing' ? 'freeform' : kind === 'ink' ? 'ink' : 'markdown'
      );
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
  type MenuTarget =
    | { kind: 'note'; id: string }
    | { kind: 'folder'; id: string }
    | { kind: 'root' };

  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let menuTarget = $state<MenuTarget | null>(null);

  function openMenu(e: MouseEvent, target: MenuTarget) {
    e.preventDefault();
    e.stopPropagation();
    const items =
      target.kind === 'root' && !canCreate && source !== 'trash'
        ? []
        : menuItemsForTarget(target);
    if (items.length === 0) return;
    menuX = e.clientX;
    menuY = e.clientY;
    menuTarget = target;
    menuOpen = true;
  }
  function closeMenu() {
    menuOpen = false;
    menuTarget = null;
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
        await emptyTrash();
      } finally {
        emptyTrashPending = false;
      }
    }
  }

  function menuItemsForTarget(target: MenuTarget): (MenuItem | 'separator')[] {
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
      const exporters = exportersForNote(note);
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

  function menuItems(): (MenuItem | 'separator')[] {
    if (!menuTarget) return [];
    return menuItemsForTarget(menuTarget);
  }

  // ---------- Drag and drop ----------
  type Drag =
    | { kind: 'note'; id: string }
    | { kind: 'folder'; id: string }
    | null;

  let drag = $state<Drag>(null);
  let dragOver = $state<string | null>(null);

  function onNoteDragStart(e: DragEvent, noteId: string) {
    if (!canReorganize) return;
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-note-id', noteId);
    e.dataTransfer.setData('text/plain', noteId);
    drag = { kind: 'note', id: noteId };
  }
  function onFolderDragStart(e: DragEvent, folderId: string) {
    if (!canReorganize) return;
    if (!e.dataTransfer) return;
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-folder-id', folderId);
    e.dataTransfer.setData('text/plain', folderId);
    drag = { kind: 'folder', id: folderId };
  }
  function onDragEnd() {
    drag = null;
    dragOver = null;
  }
  function canDropOnFolder(targetFolderId: string | null): boolean {
    if (!canReorganize) return false;
    if (!drag) return true;
    return !(drag.kind === 'folder' && targetFolderId === drag.id);
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
    if (!e.dataTransfer) return null;
    const noteId = e.dataTransfer.getData('application/x-note-id');
    if (noteId) return { kind: 'note', id: noteId };
    const folderId = e.dataTransfer.getData('application/x-folder-id');
    if (folderId) return { kind: 'folder', id: folderId };
    return null;
  }
  async function onDropOnFolder(e: DragEvent, targetFolderId: string) {
    e.preventDefault();
    e.stopPropagation();
    const payload = readPayload(e);
    dragOver = null;
    drag = null;
    if (!payload) return;
    if (payload.kind === 'note') await moveNoteTo(payload.id, targetFolderId);
    else await moveCollectionTo(payload.id, targetFolderId);
  }
  async function onDropOnRoot(e: DragEvent) {
    if (!canReorganize) return;
    e.preventDefault();
    const payload = readPayload(e);
    dragOver = null;
    drag = null;
    if (!payload) return;
    if (payload.kind === 'note') await moveNoteTo(payload.id, null);
    else await moveCollectionTo(payload.id, null);
  }

  function toggleFolder(id: string) {
    expanded[id] = !expanded[id];
  }
  function nodeKey(n: TreeNode): string {
    return n.kind === 'folder' ? `f:${n.id}` : `n:${n.id}`;
  }

  function emptyStateMessage(): string {
    switch (source) {
      case 'favourites':
        return 'Favourite notes will appear here.';
      case 'shared':
        return 'Shared folders will appear here.';
      case 'trash':
        return 'Trash is empty.';
      case 'home':
        return tUi('fileTree.emptyRoot');
    }
  }

  function updateSourceChipCollapse() {
    if (!sourceChipRow) return;
    if (!sourceChipsCollapsed) {
      expandedSourceChipWidth = sourceChipRow.scrollWidth;
    }
    const needed = expandedSourceChipWidth || sourceChipRow.scrollWidth;
    sourceChipsCollapsed = needed > sourceChipRow.clientWidth;
  }

  onMount(() => {
    const observer = new ResizeObserver(() => updateSourceChipCollapse());
    if (sourceChipRow) observer.observe(sourceChipRow);
    requestAnimationFrame(updateSourceChipCollapse);
    return () => observer.disconnect();
  });

  $effect(() => {
    void source;
    void sourceChipRow;
    void i18n.language;
    sourceChipsCollapsed = false;
    expandedSourceChipWidth = 0;
    void tick().then(() => requestAnimationFrame(updateSourceChipCollapse));
  });
</script>

<aside
  class="flex h-full w-full flex-col bg-card text-sm"
  oncontextmenu={(e) => openMenu(e, { kind: 'root' })}
>
  <div class="flex items-center justify-between gap-2 px-3 py-1.5">
    <SortControl
      strategy={ui.sortStrategy}
      direction={ui.sortDirection}
      onStrategyChange={setSortStrategy}
      onDirectionChange={setSortDirection}
      variant="ghost"
      compact
    />
    {#if canCreate}
      <div class="flex items-center gap-1">
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
        class="h-7 px-2 text-xs text-destructive hover:text-destructive"
      >
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
    {#each SOURCES as item (item.id)}
      {@const active = source === item.id}
      {@const Icon = item.icon}
      {@const label = tUi(item.labelKey)}
      <button
        type="button"
        class="source-chip inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors {active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground'}"
        class:source-chip-active={active}
        aria-current={active ? 'page' : undefined}
        aria-label={label}
        title={active ? undefined : label}
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
  >
    {#if !tree.ready}
      <p class="px-2 py-3 text-xs text-muted-foreground">
        {tUi('fileTree.loading')}
      </p>
    {:else if tree.error}
      <p class="px-2 py-3 text-xs text-destructive">
        {tUi('fileTree.error')}: {tree.error}
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
    {@const renaming =
      rename && rename.kind === 'folder' && rename.id === node.id}
    <button
      type="button"
      draggable={canReorganize}
      class="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
      class:bg-accent={isOver}
      class:opacity-60={drag?.kind === 'folder' && drag.id === node.id}
      onclick={() => toggleFolder(node.id)}
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
    {@const renaming =
      rename && rename.kind === 'note' && rename.id === node.id}
    {@const note = tree.notesById[node.id]}
    {@const fav = note?.favourite === true}
    {@const inTrash =
      source === 'trash' ||
      (note ? noteIsUnderTrash(note, tree.collectionsById) : false)}
    {@const kind = note?.note_kind}
    {@const NoteIcon = noteKindIcon(kind)}
    <!-- Row uses a flex container so the favourite-toggle button can
         sit alongside the primary open-note tap target without nesting
         <button>s. The drag handlers live on the wrapper so users can
         start a drag from either side; only the main button responds
         to click + contextmenu. -->
    <div
      role="group"
      draggable={canReorganize}
      class="group flex w-full items-center gap-0.5 rounded-md pr-1 hover:bg-accent hover:text-accent-foreground"
      class:bg-accent={isOver}
      class:opacity-60={drag?.kind === 'note' && drag.id === node.id}
      ondragstart={(e) => onNoteDragStart(e, node.id)}
      ondragend={onDragEnd}
      ondragover={(e) => onDragOverNote(e, node.id)}
      ondragleave={onDragLeave}
    >
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left"
        onclick={() => onOpenNote(node.id)}
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
          aria-pressed={fav}
          aria-label={fav ? tUi('favourite.remove') : tUi('favourite.add')}
          title={fav ? tUi('favourite.remove') : tUi('favourite.add')}
        >
          <FavouriteStar size={14} favourited={fav} />
        </button>
      {/if}
    </div>
  {/if}
{/snippet}

{#if menuOpen}
  <ContextMenu x={menuX} y={menuY} items={menuItems()} onClose={closeMenu} />
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
</style>
