<script lang="ts">
  import { ChevronRight, FileText, Folder, FolderOpen, Plus } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte';
  import {
    notes,
    createNote,
    deleteNote,
    moveNote,
    renameNote
  } from '$lib/state.svelte';

  interface Props {
    onOpenNote: (id: string) => void;
    /** Optional: open in a split pane to the right of the active editor. */
    onOpenNoteRight?: (id: string) => void;
    /** Optional: open in a split pane below the active editor. */
    onOpenNoteBelow?: (id: string) => void;
  }
  let { onOpenNote, onOpenNoteRight, onOpenNoteBelow }: Props = $props();

  let expanded = $state<Record<string, boolean>>({ Work: true, Personal: true });

  // ---------- Context menu state ----------
  type MenuTarget =
    | { kind: 'note'; id: string }
    | { kind: 'folder'; name: string }
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
      items.push(
        'separator',
        {
          label: 'Rename…',
          shortcut: 'F2',
          onSelect: () => {
            const next = window.prompt(
              'New name',
              notes.byId[id]?.title ?? 'Untitled'
            );
            if (next && next.trim()) renameNote(id, next.trim());
          }
        },
        {
          label: 'Move to root',
          onSelect: () => moveNote(id, null)
        },
        'separator',
        {
          label: 'Delete',
          shortcut: 'Del',
          destructive: true,
          onSelect: () => {
            if (window.confirm(`Delete "${notes.byId[id]?.title}"?`)) {
              deleteNote(id);
            }
          }
        }
      );
      return items;
    }
    if (menuTarget.kind === 'folder') {
      const name = menuTarget.name;
      return [
        {
          label: 'New note in folder',
          onSelect: () => {
            const id = createNote(name);
            onOpenNote(id);
          }
        },
        {
          label: 'Rename folder…',
          disabled: true,
          onSelect: () => {
            // Placeholder — folder rename TODO.
            console.info('[tree] folder rename not implemented');
          }
        },
        'separator',
        {
          label: 'Delete folder',
          destructive: true,
          disabled: true,
          onSelect: () => {
            // Placeholder — folder delete TODO (would need to move children).
            console.info('[tree] folder delete not implemented');
          }
        }
      ];
    }
    // Root context.
    return [
      {
        label: 'New note',
        onSelect: () => {
          const id = createNote(null);
          onOpenNote(id);
        }
      }
    ];
  }

  // ---------- Drag and drop ----------
  // A note can be dragged onto a folder (drop into) or onto another note
  // (insert before). Drop on the root drop-zone moves to the top level.

  let dragOver = $state<string | null>(null); // folder name or 'root' or 'note:<id>'

  function onDragStart(e: DragEvent, noteId: string) {
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-note-id', noteId);
    e.dataTransfer.setData('text/plain', noteId);
  }

  function onDragOverFolder(e: DragEvent, folderName: string) {
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dragOver = `f:${folderName}`;
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

  function onDropOnFolder(e: DragEvent, folderName: string) {
    e.preventDefault();
    const id = e.dataTransfer?.getData('application/x-note-id');
    dragOver = null;
    if (!id) return;
    moveNote(id, folderName);
  }

  function onDropOnRoot(e: DragEvent) {
    e.preventDefault();
    const id = e.dataTransfer?.getData('application/x-note-id');
    dragOver = null;
    if (!id) return;
    moveNote(id, null);
  }

  function toggleFolder(name: string) {
    expanded[name] = !expanded[name];
  }

  function newRootNote() {
    const id = createNote(null);
    onOpenNote(id);
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

  <!-- Drop on this region to move a note to the root. -->
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
    {#each notes.tree as node (node.kind === 'folder' ? `f:${node.name}` : `n:${node.id}`)}
      {#if node.kind === 'folder'}
        {@const isOver = dragOver === `f:${node.name}`}
        <button
          type="button"
          class="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
          class:bg-accent={isOver}
          onclick={() => toggleFolder(node.name)}
          oncontextmenu={(e) => openMenu(e, { kind: 'folder', name: node.name })}
          ondragover={(e) => onDragOverFolder(e, node.name)}
          ondragleave={onDragLeave}
          ondrop={(e) => onDropOnFolder(e, node.name)}
        >
          <ChevronRight
            class={`size-3.5 shrink-0 transition-transform ${expanded[node.name] ? 'rotate-90' : ''}`}
          />
          {#if expanded[node.name]}
            <FolderOpen class="size-3.5 shrink-0 text-muted-foreground" />
          {:else}
            <Folder class="size-3.5 shrink-0 text-muted-foreground" />
          {/if}
          <span class="truncate">{node.name}</span>
        </button>
        {#if expanded[node.name]}
          <div class="ml-3 border-l border-border pl-1">
            {#each node.children as child (child.kind === 'folder' ? `f:${child.name}` : `n:${child.id}`)}
              {#if child.kind === 'note'}
                {@const childOver = dragOver === `n:${child.id}`}
                <button
                  type="button"
                  draggable="true"
                  class="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                  class:bg-accent={childOver}
                  onclick={() => onOpenNote(child.id)}
                  oncontextmenu={(e) => openMenu(e, { kind: 'note', id: child.id })}
                  ondragstart={(e) => onDragStart(e, child.id)}
                  ondragover={(e) => onDragOverNote(e, child.id)}
                  ondragleave={onDragLeave}
                >
                  <FileText class="size-3.5 shrink-0 text-muted-foreground" />
                  <span class="truncate">{child.name}</span>
                </button>
              {/if}
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
          onclick={() => onOpenNote(node.id)}
          oncontextmenu={(e) => openMenu(e, { kind: 'note', id: node.id })}
          ondragstart={(e) => onDragStart(e, node.id)}
          ondragover={(e) => onDragOverNote(e, node.id)}
          ondragleave={onDragLeave}
        >
          <FileText class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="truncate">{node.name}</span>
        </button>
      {/if}
    {/each}

    {#if notes.tree.length === 0}
      <p class="px-2 py-3 text-xs text-muted-foreground">
        No notes yet. Right-click here to create one.
      </p>
    {/if}
  </div>
</aside>

{#if menuOpen}
  <ContextMenu x={menuX} y={menuY} items={menuItems()} onClose={closeMenu} />
{/if}
