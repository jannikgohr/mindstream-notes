<script lang="ts">
  /**
   * Note browser body: filters the tree by the active view + folder,
   * applies the search query, then renders as either a vertical list or
   * a 2-column grid. Folder taps drill in; note taps bubble up via
   * `onOpenNote` so the parent can route to the editor screen.
   *
   * Each row carries a "…" trigger that opens a ContextMenu with the
   * standard rename / move / delete trio (delete becomes permanent purge
   * inside the trash bucket so users can empty things manually).
   *
   * "Shared" is a placeholder bucket — there's no per-note shared flag
   * yet, so it just shows an explanatory empty state. Wire a real filter
   * in here when collab metadata lands.
   */
  import { Folder, Loader2, MoreVertical, Trash2 } from '@lucide/svelte';
  import FavouriteStar from '$lib/components/FavouriteStar.svelte';
  import type { NoteSummary, TreeNode } from '$lib/api';
  import { TRASH_ID } from '$lib/api';
  import { noteKindIcon } from '$lib/components/note-kind-icon';
  import {
    emptyTrash as emptyTrashStore,
    moveCollectionTo,
    moveNoteTo,
    purgeCollection,
    purgeNote,
    renameCollection,
    renameNote,
    restoreCollection,
    restoreNote,
    trashCollection,
    trashNote,
    tree
  } from '$lib/stores/tree.svelte';
  import { ui } from '$lib/state.svelte';
  import { sortTree } from '$lib/sort';
  import ContextMenu from '$lib/components/ContextMenu.svelte';
  import type { MenuItem } from '$lib/components/context-menu-types';
  import { alert, confirm } from '$lib/components/confirm-dialog.svelte';
  import MoveToSheet, { type MoveTarget } from './MoveToSheet.svelte';
  import NameInputSheet from './NameInputSheet.svelte';
  import {
    isFavourite,
    mobileState,
    setCurrentFolder,
    toggleFavourite
  } from './state.svelte';

  interface Props {
    onOpenNote: (id: string) => void;
    /**
     * Reserve scrollable space for MobileFab's collapsed two-button stack.
     * This keeps the final rows and their context-menu triggers reachable.
     */
    reserveFabSpace?: boolean;
  }
  let { onOpenNote, reserveFabSpace = false }: Props = $props();

  /** Locate the children of a given folder id (or roots when null). */
  function childrenOf(folderId: string | null, roots: TreeNode[]): TreeNode[] {
    if (folderId === null) return roots;
    const stack: TreeNode[] = [...roots];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.kind === 'folder') {
        if (node.id === folderId) return node.children;
        stack.push(...node.children);
      }
    }
    return [];
  }

  /**
   * True when the note lives anywhere under the trash collection — either
   * directly (`parent_collection_id === TRASH_ID`) or nested inside a
   * folder that itself was moved to trash. Used to keep trashed notes
   * out of the Favourites view even when they're still marked as
   * favourite in the database.
   */
  function isUnderTrash(note: NoteSummary): boolean {
    if (note.trashed) return true;
    let parent = note.parent_collection_id;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      if (parent === TRASH_ID) return true;
      seen.add(parent);
      parent = tree.collectionsById[parent]?.parent_collection_id ?? null;
    }
    return false;
  }

  const sortedTree = $derived(
    sortTree(
      tree.tree,
      ui.sortStrategy,
      { notesById: tree.notesById },
      ui.sortDirection
    )
  );

  // Pick the source set based on the active bottom-nav bucket. Each
  // branch returns the nodes that should appear at the current
  // currentFolderId (or "view root" when null).
  const nodes = $derived.by<TreeNode[]>(() => {
    const view = mobileState.view;
    const folderId = mobileState.currentFolderId;

    if (view === 'trash') {
      // Inside trash: roots = direct children of the trash collection,
      // drill-down follows normal folder structure.
      const base = folderId ?? TRASH_ID;
      return childrenOf(base, sortedTree);
    }

    if (view === 'favourite') {
      // Flat list, no folder drill-down (favourites span folders).
      // Notes whose ancestor folder is the trash (or a descendant of it)
      // are excluded — a favourite you've thrown away shouldn't keep
      // showing here. Restore from Trash and it comes back.
      return Object.values(tree.notesById)
        .filter((n) => n.favourite && !isUnderTrash(n))
        .map<TreeNode>((n) => ({
          kind: 'note',
          id: n.id,
          name: n.title,
          position: n.position,
          parent_collection_id: n.parent_collection_id
        }));
    }

    if (view === 'shared') {
      // No shared-note metadata in the model yet — return empty so the
      // empty-state copy explains it.
      return [];
    }

    // view === 'home' — skip the trash folder at the root.
    if (folderId === null) {
      return sortedTree.filter(
        (n) => !(n.kind === 'folder' && n.id === TRASH_ID)
      );
    }
    return childrenOf(folderId, sortedTree);
  });

  // Free-text search lives in the global SearchDialog now (mobile and
  // desktop share the Rust-backed scorer). The list itself stays a plain
  // tree view; the top-bar's search pill opens the dialog.
  const visible = $derived<TreeNode[]>(nodes);
  const showTrashRootActions = $derived(
    mobileState.view === 'trash' && mobileState.currentFolderId === null
  );
  const trashRootItemCount = $derived(
    showTrashRootActions ? visible.length : 0
  );
  const trashRootEmpty = $derived(trashRootItemCount === 0);

  function previewFor(noteId: string): string {
    const n = tree.notesById[noteId];
    if (!n) return '';
    try {
      return new Date(n.modified).toLocaleDateString();
    } catch {
      return n.modified ?? '';
    }
  }

  function handleNodeTap(node: TreeNode) {
    if (node.kind === 'folder') setCurrentFolder(node.id);
    else onOpenNote(node.id);
  }

  function emptyStateMessage(): string {
    switch (mobileState.view) {
      case 'shared':
        return 'Shared notes will appear here once you collaborate with someone.';
      case 'favourite':
        return 'Tap the star on a note to add it to your favourites.';
      case 'trash':
        return mobileState.currentFolderId
          ? 'This folder is empty.'
          : 'Trash is empty.';
      default:
        return mobileState.currentFolderId
          ? 'This folder is empty. Use the + button to add a note.'
          : 'No notes yet. Use the + button to create one.';
    }
  }

  // ---------- Context menu + move sheet ----------

  type NodeRef = { kind: 'note' | 'folder'; id: string };

  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let menuTarget = $state<NodeRef | null>(null);
  // Trigger element that opened the menu — passed to ContextMenu as
  // `ignoreEl` so pointerdown on the same button doesn't close-then-
  // reopen, and consulted here to make a re-tap collapse the menu.
  let menuTriggerEl = $state<HTMLElement | null>(null);

  let moveTarget = $state<MoveTarget | null>(null);
  let renameTarget = $state<NodeRef | null>(null);
  let emptyTrashPending = $state(false);

  function openContextMenu(e: MouseEvent, target: NodeRef) {
    e.stopPropagation();
    const trigger = e.currentTarget as HTMLElement;
    if (menuOpen && menuTriggerEl === trigger) {
      closeMenu();
      return;
    }
    const r = trigger.getBoundingClientRect();
    // Anchor the menu under the trigger button, right-aligned-ish via
    // ContextMenu's own clamping logic.
    menuX = r.right - 200;
    menuY = r.bottom + 4;
    menuTarget = target;
    menuTriggerEl = trigger;
    menuOpen = true;
  }

  function closeMenu() {
    menuOpen = false;
    menuTarget = null;
    menuTriggerEl = null;
  }

  function nameFor(t: NodeRef): string {
    return t.kind === 'note'
      ? (tree.notesById[t.id]?.title ?? 'note')
      : (tree.collectionsById[t.id]?.name ?? 'folder');
  }

  function currentParentOf(t: NodeRef): string | null {
    return t.kind === 'note'
      ? (tree.notesById[t.id]?.parent_collection_id ?? null)
      : (tree.collectionsById[t.id]?.parent_collection_id ?? null);
  }

  function startRename(t: NodeRef) {
    renameTarget = t;
  }

  async function commitRename(name: string) {
    const t = renameTarget;
    renameTarget = null;
    if (!t) return;
    if (name === nameFor(t)) return;
    if (t.kind === 'note') await renameNote(t.id, name);
    else await renameCollection(t.id, name);
  }

  function startMove(t: NodeRef) {
    moveTarget = {
      kind: t.kind,
      id: t.id,
      currentParent: currentParentOf(t)
    };
  }

  async function commitMove(destination: string | null) {
    const t = moveTarget;
    moveTarget = null;
    if (!t) return;
    if (t.kind === 'note') await moveNoteTo(t.id, destination);
    else await moveCollectionTo(t.id, destination);
  }

  async function startTrash(t: NodeRef) {
    const label = nameFor(t);
    if (
      !(await confirm({
        title:
          t.kind === 'note' ? 'Move note to trash' : 'Move folder to trash',
        message: `"${label}" will move to the trash. You can restore it from there later.`,
        confirmLabel: 'Move to trash',
        destructive: true
      }))
    ) {
      return;
    }
    if (t.kind === 'note') void trashNote(t.id);
    else void trashCollection(t.id);
  }

  async function startPurge(t: NodeRef) {
    const label = nameFor(t);
    if (
      !(await confirm({
        title: 'Delete permanently',
        message:
          t.kind === 'folder'
            ? `Folder "${label}" and everything inside will be removed. This cannot be undone.`
            : `"${label}" will be removed. This cannot be undone.`,
        confirmLabel: 'Delete',
        destructive: true
      }))
    ) {
      return;
    }
    if (t.kind === 'note') void purgeNote(t.id);
    else void purgeCollection(t.id);
  }

  async function startEmptyTrash() {
    if (emptyTrashPending || trashRootEmpty) return;
    if (
      !(await confirm({
        title: 'Delete all permanently',
        message:
          'Everything in Trash will be removed. This includes items inside trashed folders and cannot be undone.',
        confirmLabel: 'Delete all',
        destructive: true
      }))
    ) {
      return;
    }

    emptyTrashPending = true;
    try {
      await emptyTrashStore();
    } catch (err) {
      console.error('[mobile] empty trash failed', err);
      await alert({
        title: "Couldn't empty Trash",
        message: String(err)
      });
    } finally {
      emptyTrashPending = false;
    }
  }

  function startRestore(t: NodeRef) {
    if (t.kind === 'note') void restoreNote(t.id);
    else void restoreCollection(t.id);
  }

  function menuItems(): (MenuItem | 'separator')[] {
    const t = menuTarget;
    if (!t) return [];
    // Inside the trash bucket the only meaningful actions are
    // restoring the item or purging it; rename / move-to don't apply
    // until something is rescued back out of the trash.
    if (mobileState.view === 'trash') {
      return [
        { label: 'Restore', onSelect: () => startRestore(t) },
        'separator',
        {
          label: 'Delete permanently',
          destructive: true,
          onSelect: () => void startPurge(t)
        }
      ];
    }
    return [
      { label: 'Rename', onSelect: () => startRename(t) },
      { label: 'Move to…', onSelect: () => startMove(t) },
      'separator',
      {
        label: 'Delete',
        destructive: true,
        onSelect: () => void startTrash(t)
      }
    ];
  }
</script>

<div
  class:fab-space={reserveFabSpace}
  class="mobile-note-list flex-1 overflow-y-auto px-3 pt-3"
>
  {#if !tree.ready}
    <p class="px-1 py-2 text-sm text-muted-foreground">Loading…</p>
  {:else if tree.error}
    <p class="px-1 py-2 text-sm text-destructive">
      Couldn't load notes: {tree.error}
    </p>
  {:else}
    {#if showTrashRootActions && !trashRootEmpty}
      <div class="mb-3 flex justify-start">
        <button
          type="button"
          class="inline-flex h-9 max-w-full shrink-0 items-center justify-center gap-1.5 rounded-md bg-destructive px-3 text-xs font-semibold text-destructive-foreground shadow-sm transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
          onclick={() => void startEmptyTrash()}
          disabled={trashRootEmpty || emptyTrashPending}
          aria-label="Delete all trash permanently"
          title="Delete all permanently"
        >
          {#if emptyTrashPending}
            <Loader2 class="size-3.5 animate-spin" />
          {:else}
            <Trash2 class="size-3.5" />
          {/if}
          <span class="truncate">Delete all permanently</span>
        </button>
      </div>
    {/if}

    {#if visible.length === 0}
      <p class="px-1 py-6 text-center text-sm text-muted-foreground">
        {emptyStateMessage()}
      </p>
    {:else if mobileState.displayMode === 'grid'}
      <div class="grid grid-cols-2 gap-2">
        {#each visible as node (node.kind + ':' + node.id)}
          {@const fav = node.kind === 'note' && isFavourite(node.id)}
          {@const noteKind =
            node.kind === 'note' ? tree.notesById[node.id]?.note_kind : null}
          <!-- Wrapper is a div so the favourite-toggle button can sit inside
             alongside the primary tap target without nesting <button>s. -->
          <div
            class="relative h-32 rounded-lg border border-border bg-card shadow-sm"
          >
            <button
              type="button"
              class="flex h-full w-full flex-col items-start gap-1.5 rounded-lg p-3 pr-9 text-left hover:bg-accent/50"
              onclick={() => handleNodeTap(node)}
            >
              {#if node.kind === 'folder'}
                <Folder class="size-5 text-muted-foreground" />
              {:else}
                {@const Icon = noteKindIcon(noteKind)}
                <Icon class="size-5 text-muted-foreground" />
              {/if}
              <span class="line-clamp-2 text-sm font-medium">{node.name}</span>
              {#if node.kind === 'note'}
                <span class="mt-auto text-[10px] text-muted-foreground">
                  {previewFor(node.id)}
                </span>
              {/if}
            </button>
            <div
              class="absolute right-1 top-1 flex flex-col items-center gap-0.5"
            >
              {#if node.kind === 'note'}
                <button
                  type="button"
                  class="rounded p-1 text-muted-foreground hover:text-foreground"
                  onclick={() => toggleFavourite(node.id)}
                  aria-pressed={fav}
                  aria-label={fav
                    ? 'Remove from favourites'
                    : 'Add to favourites'}
                  title={fav ? 'Remove from favourites' : 'Add to favourites'}
                >
                  <FavouriteStar size={16} favourited={fav} />
                </button>
              {/if}
              <button
                type="button"
                class="rounded p-1 text-muted-foreground hover:text-foreground"
                onclick={(e) =>
                  openContextMenu(e, { kind: node.kind, id: node.id })}
                aria-label="More actions"
                title="More actions"
              >
                <MoreVertical class="size-4" />
              </button>
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <ul class="flex flex-col">
        {#each visible as node (node.kind + ':' + node.id)}
          {@const fav = node.kind === 'note' && isFavourite(node.id)}
          {@const noteKind =
            node.kind === 'note' ? tree.notesById[node.id]?.note_kind : null}
          <li class="flex w-full items-center gap-1">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2.5 text-left hover:bg-accent"
              onclick={() => handleNodeTap(node)}
            >
              {#if node.kind === 'folder'}
                <Folder class="size-5 shrink-0 text-muted-foreground" />
              {:else}
                {@const Icon = noteKindIcon(noteKind)}
                <Icon class="size-5 shrink-0 text-muted-foreground" />
              {/if}
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="truncate text-sm font-medium">{node.name}</span>
                {#if node.kind === 'note'}
                  <span class="truncate text-xs text-muted-foreground">
                    {previewFor(node.id)}
                  </span>
                {/if}
              </span>
            </button>
            {#if node.kind === 'note'}
              <button
                type="button"
                class="shrink-0 rounded p-2 text-muted-foreground hover:text-foreground"
                onclick={() => toggleFavourite(node.id)}
                aria-pressed={fav}
                aria-label={fav
                  ? 'Remove from favourites'
                  : 'Add to favourites'}
                title={fav ? 'Remove from favourites' : 'Add to favourites'}
              >
                <FavouriteStar size={16} favourited={fav} />
              </button>
            {/if}
            <button
              type="button"
              class="shrink-0 rounded p-2 text-muted-foreground hover:text-foreground"
              onclick={(e) =>
                openContextMenu(e, { kind: node.kind, id: node.id })}
              aria-label="More actions"
              title="More actions"
            >
              <MoreVertical class="size-4" />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

{#if menuOpen}
  <ContextMenu
    x={menuX}
    y={menuY}
    items={menuItems()}
    ignoreEl={menuTriggerEl}
    onClose={closeMenu}
  />
{/if}

{#if moveTarget}
  <MoveToSheet
    target={moveTarget}
    onPick={(d) => void commitMove(d)}
    onClose={() => (moveTarget = null)}
  />
{/if}

{#if renameTarget}
  <NameInputSheet
    title={renameTarget.kind === 'note' ? 'Rename note' : 'Rename folder'}
    placeholder={renameTarget.kind === 'note' ? 'Note title' : 'Folder name'}
    initialValue={nameFor(renameTarget)}
    submitLabel="Save"
    onSubmit={(n) => void commitRename(n)}
    onClose={() => (renameTarget = null)}
  />
{/if}

<style>
  .mobile-note-list {
    padding-bottom: 0.75rem;
  }

  .mobile-note-list.fab-space {
    /*
     * MobileFab is anchored 1rem from the bottom and its collapsed stack is:
     * primary 3.5rem + gap 0.75rem + plus 3rem. Keeping this as scrollable
     * padding lets the last row clear the buttons at max scroll.
     */
    padding-bottom: 9.5rem;
    scroll-padding-bottom: 9.5rem;
  }
</style>
