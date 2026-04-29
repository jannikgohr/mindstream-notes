<script lang="ts">
  import { ArrowDownAZ, ChevronRight, FileText, Folder, FolderOpen, Plus } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte';
  import { SORT_STRATEGIES, sortTree, type SortStrategy } from '$lib/sort';
  import {
    tree,
    createCollectionIn,
    createNoteIn,
    moveCollectionTo,
    moveNoteTo,
    renameCollectionById,
    renameNoteById,
    trashNoteById
  } from '$lib/stores/tree.svelte';
  import { setSortStrategy, ui } from '$lib/state.svelte';
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

  // Apply the active sort strategy to whatever the tree store currently holds.
  const sortedTree = $derived(
    sortTree(tree.tree, ui.sortStrategy, { notesById: tree.notesById })
  );

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
          onSelect: () => {
            const next = window.prompt('New name', note?.title ?? 'Untitled');
            if (next && next.trim()) void renameNoteById(id, next.trim());
          }
        },
        {
          label: 'Move to root',
          onSelect: () => void moveNoteTo(id, null)
        },
        'separator',
        {
          label: 'Delete',
          shortcut: 'Del',
          destructive: true,
          onSelect: () => {
            if (window.confirm(`Delete "${note?.title ?? 'note'}"?`)) {
              void trashNoteById(id);
            }
          }
        }
      );
      return items;
    }
    if (menuTarget.kind === 'folder') {
      const id = menuTarget.id;
      const folder = tree.collectionsById[id];
      return [
        {
          label: 'New note in folder',
          onSelect: async () => {
            const noteId = await createNoteIn(id);
            onOpenNote(noteId);
          }
        },
        {
          label: 'New folder inside',
          onSelect: async () => {
            const name = window.prompt('Folder name', 'Untitled folder');
            if (name && name.trim()) await createCollectionIn(id, name.trim());
          }
        },
        {
          label: 'Move to root',
          onSelect: () => void moveCollectionTo(id, null)
        },
        {
          label: 'Rename folder…',
          onSelect: () => {
            const next = window.prompt('Folder name', folder?.name ?? 'Folder');
            if (next && next.trim()) void renameCollectionById(id, next.trim());
          }
        }
      ];
    }
    return [
      {
        label: 'New note',
        onSelect: async () => {
          const noteId = await createNoteIn(null);
          onOpenNote(noteId);
        }
      },
      {
        label: 'New folder',
        onSelect: async () => {
          const name = window.prompt('Folder name', 'Untitled folder');
          if (name && name.trim()) await createCollectionIn(null, name.trim());
        }
      }
    ];
  }

  // ---------- Drag and drop ----------
  type Drag =
    | { kind: 'note'; id: string }
    | { kind: 'folder'; id: string }
    | null;

  let drag = $state<Drag>(null);
  let dragOver = $state<string | null>(null); // 'root' | `f:${id}` | `n:${id}`

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
    if (drag.kind === 'folder' && targetFolderId === drag.id) return false;
    return true;
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
  async function newRootNote() {
    const id = await createNoteIn(null);
    onOpenNote(id);
  }

  // Convenience for the recursive renderer below.
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
      <Button
        variant="ghost"
        size="icon"
        onclick={openSortMenu}
        title="Sort"
        aria-label="Sort notes"
      >
        <ArrowDownAZ class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onclick={newRootNote}
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
    {:else if sortedTree.length === 0}
      <p class="px-2 py-3 text-xs text-muted-foreground">
        No notes yet. Right-click here to create one.
      </p>
    {/if}

    {#each sortedTree as node (nodeKey(node))}
      {@render renderNode(node)}
    {/each}
  </div>
</aside>

{#snippet renderNode(node: TreeNode)}
  {#if node.kind === 'folder'}
    {@const isOver = dragOver === `f:${node.id}`}
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
      <span class="truncate">{node.name}</span>
    </button>
    {#if expanded[node.id]}
      <div class="ml-3 border-l border-border pl-1">
        {#each node.children as child (nodeKey(child))}
          {@render renderNode(child)}
        {/each}
      </div>
    {/if}
  {:else}
    {@const isOver = dragOver === `n:${node.id}`}
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
      <span class="truncate">{node.name}</span>
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
