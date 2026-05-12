<script lang="ts">
  import {
    ArrowDownAZ,
    ChevronRight,
    FileText,
    Folder,
    FolderOpen,
    FolderPlus,
    Plus,
    Trash2
  } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte';
  import { confirm } from './ConfirmDialog.svelte';
  import { SORT_STRATEGIES, sortTree, type SortStrategy } from '$lib/sort';
  import {
    tree,
    createCollectionIn,
    createNoteIn,
    emptyTrash,
    moveCollectionTo,
    moveNoteTo,
    purgeCollection,
    purgeNote,
    renameCollection,
    renameNote,
    restoreCollection,
    restoreNote,
    trashCollection,
    trashNote
  } from '$lib/stores/tree.svelte';
  import { setSortStrategy, ui } from '$lib/state.svelte';
  import { TRASH_ID } from '$lib/api';
  import type { TreeNode } from '$lib/api';

  interface Props {
    onOpenNote: (id: string) => void;
    onOpenNoteRight?: (id: string) => void;
    onOpenNoteBelow?: (id: string) => void;
    onOpenInNewWindow?: (id: string) => void;
  }
  let {
    onOpenNote,
    onOpenNoteRight,
    onOpenNoteBelow,
    onOpenInNewWindow
  }: Props = $props();

  let expanded = $state<Record<string, boolean>>({});

  const sortedTree = $derived(
    sortTree(tree.tree, ui.sortStrategy, { notesById: tree.notesById })
  );

  // Pull the trash folder out of sortedTree so it can be pinned at the
  // bottom with its own context menu and icon. mainNodes is everything else.
  const trashNode = $derived(
    sortedTree.find((n) => n.kind === 'folder' && n.id === TRASH_ID) ?? null
  );
  const mainNodes = $derived(
    sortedTree.filter((n) => !(n.kind === 'folder' && n.id === TRASH_ID))
  );

  // ---------- Inline draft entry (replaces window.prompt) ----------
  type Draft = {
    kind: 'note' | 'folder';
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

  $effect(() => {
    if (!nameInput) return;
    queueMicrotask(() => {
      nameInput?.focus();
      nameInput?.select();
    });
  });

  function startDraft(kind: 'note' | 'folder', parentId: string | null) {
    if (parentId) expanded[parentId] = true;
    draft = {
      kind,
      parentId,
      text: kind === 'note' ? 'Untitled' : 'Untitled folder'
    };
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
    if (kind === 'note') {
      const id = await createNoteIn(parentId, text);
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

  // ---------- Sort menu ----------
  let sortMenuOpen = $state(false);
  let sortMenuX = $state(0);
  let sortMenuY = $state(0);

  function openSortMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    sortMenuX = r.left;
    sortMenuY = r.bottom + 4;
    sortMenuOpen = true;
  }
  function closeSortMenu() {
    sortMenuOpen = false;
  }
  function sortMenuItems(): (MenuItem | 'separator')[] {
    return SORT_STRATEGIES.map((opt) => ({
      label: (ui.sortStrategy === opt.id ? '✓  ' : '    ') + opt.label,
      onSelect: () => setSortStrategy(opt.id as SortStrategy)
    }));
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
    menuX = e.clientX;
    menuY = e.clientY;
    menuTarget = target;
    menuOpen = true;
  }
  function closeMenu() {
    menuOpen = false;
    menuTarget = null;
  }

  function menuItems(): (MenuItem | 'separator')[] {
    if (!menuTarget) return [];
    if (menuTarget.kind === 'note') {
      const id = menuTarget.id;
      const note = tree.notesById[id];

      // Notes inside the trash get a stripped-down menu.
      if (note?.parent_collection_id === TRASH_ID) {
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

    if (menuTarget.kind === 'folder') {
      const id = menuTarget.id;
      const folder = tree.collectionsById[id];

      // Trash folder itself: only "Empty trash".
      if (id === TRASH_ID) {
        const trashedCount =
          Object.values(tree.notesById).filter(
            (n) => n.parent_collection_id === TRASH_ID
          ).length +
          Object.values(tree.collectionsById).filter(
            (c) => c.parent_collection_id === TRASH_ID
          ).length;
        return [
          {
            label: `Empty trash (${trashedCount})`,
            destructive: true,
            disabled: trashedCount === 0,
            onSelect: async () => {
              if (
                await confirm({
                  title: 'Empty trash',
                  message: `${trashedCount} item(s) will be removed permanently. This cannot be undone.`,
                  confirmLabel: 'Empty trash',
                  destructive: true
                })
              ) {
                void emptyTrash();
              }
            }
          }
        ];
      }

      // Sub-folders inside trash — restore or purge.
      if (folder?.parent_collection_id === TRASH_ID) {
        return [
          { label: 'Restore', onSelect: () => void restoreCollection(id) },
          {
            label: 'Delete permanently',
            destructive: true,
            onSelect: async () => {
              if (
                await confirm({
                  title: 'Delete folder permanently',
                  message: `Folder "${folder.name}" and everything inside will be removed. This cannot be undone.`,
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

      return [
        { label: 'New note in folder', onSelect: () => startDraft('note', id) },
        { label: 'New folder inside', onSelect: () => startDraft('folder', id) },
        'separator',
        {
          label: 'Rename folder…',
          shortcut: 'F2',
          onSelect: () => startRename('folder', id, folder?.name ?? 'Folder')
        },
        { label: 'Move to root', onSelect: () => void moveCollectionTo(id, null) },
        'separator',
        {
          label: 'Delete',
          shortcut: 'Del',
          destructive: true,
          onSelect: () => void trashCollection(id)
        }
      ];
    }

    return [
      { label: 'New note', onSelect: () => startDraft('note', null) },
      { label: 'New folder', onSelect: () => startDraft('folder', null) }
    ];
  }

  // ---------- Drag and drop ----------
  type Drag =
    | { kind: 'note'; id: string }
    | { kind: 'folder'; id: string }
    | null;

  let drag = $state<Drag>(null);
  let dragOver = $state<string | null>(null);

  function onNoteDragStart(e: DragEvent, noteId: string) {
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-note-id', noteId);
    e.dataTransfer.setData('text/plain', noteId);
    drag = { kind: 'note', id: noteId };
  }
  function onFolderDragStart(e: DragEvent, folderId: string) {
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
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dragOver = 'root';
  }
  function onDragOverNote(e: DragEvent, noteId: string) {
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
</script>

<aside
  class="flex h-full w-full flex-col bg-card text-sm"
  oncontextmenu={(e) => openMenu(e, { kind: 'root' })}
>
  <div class="flex items-center justify-between px-3 py-2">
    <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      Explorer
    </span>
    <div class="flex items-center gap-1">
      <Button variant="ghost" size="icon" onclick={openSortMenu} title="Sort" aria-label="Sort notes">
        <ArrowDownAZ class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onclick={() => startDraft('folder', null)}
        title="New folder"
        aria-label="New folder"
      >
        <FolderPlus class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onclick={() => startDraft('note', null)}
        title="New note"
        aria-label="New note"
      >
        <Plus class="size-3.5" />
      </Button>
    </div>
  </div>

  <div
    role="group"
    aria-label="File tree"
    class="flex-1 overflow-y-auto px-1 pb-2"
    class:ring-1={dragOver === 'root'}
    class:ring-ring={dragOver === 'root'}
    ondragover={onDragOverRoot}
    ondragleave={onDragLeave}
    ondrop={onDropOnRoot}
  >
    {#if !tree.ready}
      <p class="px-2 py-3 text-xs text-muted-foreground">Loading…</p>
    {:else if tree.error}
      <p class="px-2 py-3 text-xs text-destructive">
        Couldn't load notes: {tree.error}
      </p>
    {:else if mainNodes.length === 0 && !draft}
      <p class="px-2 py-3 text-xs text-muted-foreground">
        No notes yet. Right-click here to create one.
      </p>
    {/if}

    {#each mainNodes as node (nodeKey(node))}
      {@render renderNode(node)}
    {/each}

    {#if draft && draft.parentId === null}
      {@render renderDraft()}
    {/if}

    {#if trashNode && trashNode.kind === 'folder'}
      <div class="my-3 border-t border-border"></div>
      {@render renderTrash(trashNode)}
    {/if}
  </div>
</aside>

{#snippet renderDraft()}
  {@const isFolder = draft?.kind === 'folder'}
  <div class="my-0.5 flex items-center gap-1.5 rounded-md px-2 py-0.5">
    {#if isFolder}
      <Folder class="size-3.5 shrink-0 text-muted-foreground" />
    {:else}
      <FileText class="size-3.5 shrink-0 text-muted-foreground" />
    {/if}
    <Input
      bind:ref={nameInput}
      bind:value={draft!.text}
      placeholder={isFolder ? 'Folder name' : 'Note title'}
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

{#snippet renderTrash(node: TreeNode & { kind: 'folder' })}
  {@const isOver = dragOver === `f:${node.id}`}
  {@const childCount = node.children.length}
  <button
    type="button"
    class="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
    class:bg-accent={isOver}
    onclick={() => toggleFolder(node.id)}
    oncontextmenu={(e) => openMenu(e, { kind: 'folder', id: node.id })}
    ondragover={(e) => onDragOverFolder(e, node.id)}
    ondragleave={onDragLeave}
    ondrop={(e) => onDropOnFolder(e, node.id)}
  >
    <ChevronRight
      class={`size-3.5 shrink-0 transition-transform ${expanded[node.id] ? 'rotate-90' : ''}`}
    />
    <Trash2 class="size-3.5 shrink-0 text-muted-foreground" />
    <span class="truncate">{node.name}</span>
    {#if childCount > 0}
      <span class="ml-auto text-[10px] text-muted-foreground">{childCount}</span>
    {/if}
  </button>
  {#if expanded[node.id]}
    <div class="ml-3 border-l border-border pl-1">
      {#each node.children as child (nodeKey(child))}
        {@render renderNode(child)}
      {/each}
      {#if childCount === 0}
        <p class="px-2 py-1 text-[11px] italic text-muted-foreground">Empty</p>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet renderNode(node: TreeNode)}
  {#if node.kind === 'folder'}
    {@const isOver = dragOver === `f:${node.id}`}
    {@const renaming = rename && rename.kind === 'folder' && rename.id === node.id}
    <button
      type="button"
      draggable="true"
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
        {#if draft && draft.parentId === node.id}
          {@render renderDraft()}
        {/if}
      </div>
    {/if}
  {:else}
    {@const isOver = dragOver === `n:${node.id}`}
    {@const renaming = rename && rename.kind === 'note' && rename.id === node.id}
    <button
      type="button"
      draggable="true"
      class="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
      class:bg-accent={isOver}
      class:opacity-60={drag?.kind === 'note' && drag.id === node.id}
      onclick={() => onOpenNote(node.id)}
      oncontextmenu={(e) => openMenu(e, { kind: 'note', id: node.id })}
      ondragstart={(e) => onNoteDragStart(e, node.id)}
      ondragend={onDragEnd}
      ondragover={(e) => onDragOverNote(e, node.id)}
      ondragleave={onDragLeave}
    >
      <FileText class="size-3.5 shrink-0 text-muted-foreground" />
      {#if renaming}
        {@render renderRenameInput()}
      {:else}
        <span class="truncate">{node.name}</span>
      {/if}
    </button>
  {/if}
{/snippet}

{#if menuOpen}
  <ContextMenu x={menuX} y={menuY} items={menuItems()} onClose={closeMenu} />
{/if}

{#if sortMenuOpen}
  <ContextMenu
    x={sortMenuX}
    y={sortMenuY}
    items={sortMenuItems()}
    onClose={closeSortMenu}
  />
{/if}
