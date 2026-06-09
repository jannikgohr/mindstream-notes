<script lang="ts">
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
    Star,
    Trash2
  } from 'lucide-svelte';
  import { noteKindIcon } from './note-kind-icon';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Separator } from '$lib/components/ui/separator';
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte';
  import { confirm } from './confirm-dialog.svelte';
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
  import { tUi } from '$lib/settings/i18n.svelte';
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
    sortTree(
      tree.tree,
      ui.sortStrategy,
      { notesById: tree.notesById },
      ui.sortDirection
    )
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

  $effect(() => {
    if (!nameInput) return;
    queueMicrotask(() => {
      nameInput?.focus();
      nameInput?.select();
    });
  });

  function startDraft(kind: DraftKind, parentId: string | null) {
    if (parentId) expanded[parentId] = true;
    const defaultText =
      kind === 'folder'
        ? 'Untitled folder'
        : kind === 'drawing'
          ? 'Untitled drawing'
          : kind === 'ink'
            ? 'Untitled ink note'
            : 'Untitled';
    draft = { kind, parentId, text: defaultText };
  }
  function startPdfImport(parentId: string | null) {
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
        {
          label: 'New drawing in folder',
          onSelect: () => startDraft('drawing', id)
        },
        {
          label: 'New ink note in folder',
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

    return [
      { label: 'New note', onSelect: () => startDraft('note', null) },
      { label: 'New drawing', onSelect: () => startDraft('drawing', null) },
      { label: 'New ink note', onSelect: () => startDraft('ink', null) },
      { label: 'Import PDF', onSelect: () => startPdfImport(null) },
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
  <div class="flex items-center justify-between gap-2 px-3 py-1">
    <SortControl
      strategy={ui.sortStrategy}
      direction={ui.sortDirection}
      onStrategyChange={setSortStrategy}
      onDirectionChange={setSortDirection}
      variant="ghost"
      compact
    />
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
  </div>

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
    {:else if mainNodes.length === 0 && !draft}
      <p class="px-2 py-3 text-xs text-muted-foreground">
        {tUi('fileTree.emptyRoot')}
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
      <span class="ml-auto text-[10px] text-muted-foreground">{childCount}</span
      >
    {/if}
  </button>
  {#if expanded[node.id]}
    <div class="ml-3 border-l border-border pl-1">
      {#each node.children as child (nodeKey(child))}
        {@render renderNode(child)}
      {/each}
      {#if childCount === 0}
        <p class="px-2 py-1 text-[11px] italic text-muted-foreground">
          {tUi('fileTree.emptyFolder')}
        </p>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet renderNode(node: TreeNode)}
  {#if node.kind === 'folder'}
    {@const isOver = dragOver === `f:${node.id}`}
    {@const renaming =
      rename && rename.kind === 'folder' && rename.id === node.id}
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
    {@const renaming =
      rename && rename.kind === 'note' && rename.id === node.id}
    {@const note = tree.notesById[node.id]}
    {@const fav = note?.favourite === true}
    {@const inTrash = note?.parent_collection_id === TRASH_ID}
    {@const kind = note?.note_kind}
    {@const NoteIcon = noteKindIcon(kind)}
    <!-- Row uses a flex container so the favourite-toggle button can
         sit alongside the primary open-note tap target without nesting
         <button>s. The drag handlers live on the wrapper so users can
         start a drag from either side; only the main button responds
         to click + contextmenu. -->
    <div
      role="group"
      draggable="true"
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
          <Star class="size-3.5" fill={fav ? 'currentColor' : 'none'} />
        </button>
      {/if}
    </div>
  {/if}
{/snippet}

{#if menuOpen}
  <ContextMenu x={menuX} y={menuY} items={menuItems()} onClose={closeMenu} />
{/if}
