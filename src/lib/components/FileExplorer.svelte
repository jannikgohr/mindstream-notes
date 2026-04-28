<script lang="ts">
  import { ChevronRight, FileText, Folder, FolderOpen, Plus } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte';
  import {
    notes,
    createNote,
    deleteNote,
    moveFolder,
    moveNote,
    renameNote
  } from '$lib/state.svelte';

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
          label: 'Move to root',
          onSelect: () => moveFolder(name, null)
        },
        {
          label: 'Rename folder…',
          disabled: true,
          onSelect: () => console.info('[tree] folder rename not implemented')
        },
        'separator',
        {
          label: 'Delete folder',
          destructive: true,
          disabled: true,
          onSelect: () => console.info('[tree] folder delete not implemented')
        }
      ];
    }
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
  // Two payload mime types so drop handlers can disambiguate:
  //   application/x-note-id    -> moveNote(id, target)
  //   application/x-folder-name -> moveFolder(name, target)

  type Drag =
    | { kind: 'note'; id: string }
    | { kind: 'folder'; name: string }
    | null;

  let drag = $state<Drag>(null); // what's currently being dragged
  let dragOver = $state<string | null>(null); // target key: 'root' | `f:${name}` | `n:${id}`

  function onNoteDragStart(e: DragEvent, noteId: string) {
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-note-id', noteId);
    e.dataTransfer.setData('text/plain', noteId);
    drag = { kind: 'note', id: noteId };
  }

  function onFolderDragStart(e: DragEvent, folderName: string) {
    if (!e.dataTransfer) return;
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-folder-name', folderName);
    e.dataTransfer.setData('text/plain', folderName);
    drag = { kind: 'folder', name: folderName };
  }

  function onDragEnd() {
    drag = null;
    dragOver = null;
  }

  /**
   * Decide whether the current drag can be dropped on `targetFolder`.
   * Notes can land on any folder. Folders can land on any folder that's
   * not themselves or one of their descendants — but we only know that
   * deeply at drop time, so we settle for a name check here and let
   * moveFolder() do the strict validation on drop.
   */
  function canDropOnFolder(targetFolder: string | null): boolean {
    if (!drag) return true;
    if (drag.kind === 'folder' && targetFolder === drag.name) return false;
    return true;
  }

  function onDragOverFolder(e: DragEvent, folderName: string) {
    if (!e.dataTransfer) return;
    if (!canDropOnFolder(folderName)) return;
    e.preventDefault();
    e.stopPropagation();
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

  function readPayload(e: DragEvent): Drag {
    if (!e.dataTransfer) return null;
    const noteId = e.dataTransfer.getData('application/x-note-id');
    if (noteId) return { kind: 'note', id: noteId };
    const folderName = e.dataTransfer.getData('application/x-folder-name');
    if (folderName) return { kind: 'folder', name: folderName };
    return null;
  }

  function onDropOnFolder(e: DragEvent, targetFolder: string) {
    e.preventDefault();
    e.stopPropagation();
    const payload = readPayload(e);
    dragOver = null;
    drag = null;
    if (!payload) return;
    if (payload.kind === 'note') {
      moveNote(payload.id, targetFolder);
    } else {
      moveFolder(payload.name, targetFolder);
    }
  }

  function onDropOnRoot(e: DragEvent) {
    e.preventDefault();
    const payload = readPayload(e);
    dragOver = null;
    drag = null;
    if (!payload) return;
    if (payload.kind === 'note') {
      moveNote(payload.id, null);
    } else {
      moveFolder(payload.name, null);
    }
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
          draggable="true"
          class="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
          class:bg-accent={isOver}
          class:opacity-60={drag?.kind === 'folder' && drag.name === node.name}
          onclick={() => toggleFolder(node.name)}
          oncontextmenu={(e) => openMenu(e, { kind: 'folder', name: node.name })}
          ondragstart={(e) => onFolderDragStart(e, node.name)}
          ondragend={onDragEnd}
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
                  class:opacity-60={drag?.kind === 'note' && drag.id === child.id}
                  onclick={() => onOpenNote(child.id)}
                  oncontextmenu={(e) => openMenu(e, { kind: 'note', id: child.id })}
                  ondragstart={(e) => onNoteDragStart(e, child.id)}
                  ondragend={onDragEnd}
                  ondragover={(e) => onDragOverNote(e, child.id)}
                  ondragleave={onDragLeave}
                >
                  <FileText class="size-3.5 shrink-0 text-muted-foreground" />
                  <span class="truncate">{child.name}</span>
                </button>
              {:else}
                <!-- Nested folders: render as a smaller folder row that
                     itself accepts drops + context menu. -->
                {@const nestedOver = dragOver === `f:${child.name}`}
                <button
                  type="button"
                  draggable="true"
                  class="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                  class:bg-accent={nestedOver}
                  class:opacity-60={drag?.kind === 'folder' && drag.name === child.name}
                  onclick={() => toggleFolder(child.name)}
                  oncontextmenu={(e) => openMenu(e, { kind: 'folder', name: child.name })}
                  ondragstart={(e) => onFolderDragStart(e, child.name)}
                  ondragend={onDragEnd}
                  ondragover={(e) => onDragOverFolder(e, child.name)}
                  ondragleave={onDragLeave}
                  ondrop={(e) => onDropOnFolder(e, child.name)}
                >
                  <ChevronRight
                    class={`size-3.5 shrink-0 transition-transform ${expanded[child.name] ? 'rotate-90' : ''}`}
                  />
                  {#if expanded[child.name]}
                    <FolderOpen class="size-3.5 shrink-0 text-muted-foreground" />
                  {:else}
                    <Folder class="size-3.5 shrink-0 text-muted-foreground" />
                  {/if}
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
