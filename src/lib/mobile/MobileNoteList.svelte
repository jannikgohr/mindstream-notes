<script lang="ts">
  /**
   * Note browser body: filters the tree by the active view + folder,
   * applies the search query, then renders as either a vertical list or
   * a 2-column grid. Folder taps drill in; note taps bubble up via
   * `onOpenNote` so the parent can route to the editor screen.
   *
   * "Shared" is a placeholder bucket — there's no per-note shared flag
   * yet, so it just shows an explanatory empty state. Wire a real filter
   * in here when collab metadata lands.
   */
  import { FileText, Folder, Star } from 'lucide-svelte';
  import type { NoteSummary, TreeNode } from '$lib/api';
  import { TRASH_ID } from '$lib/api';
  import { tree } from '$lib/stores/tree.svelte';
  import { ui } from '$lib/state.svelte';
  import { sortTree } from '$lib/sort';
  import {
    favourites,
    isFavourite,
    mobileState,
    setCurrentFolder,
    toggleFavourite
  } from './state.svelte';

  interface Props {
    onOpenNote: (id: string) => void;
  }
  let { onOpenNote }: Props = $props();

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

  const sortedTree = $derived(
    sortTree(tree.tree, ui.sortStrategy, { notesById: tree.notesById })
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
      // Read favourites.ids so Svelte tracks the dependency.
      const favSet = favourites.ids;
      return Object.values(tree.notesById)
        .filter((n) => favSet.has(n.id) && !n.trashed)
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
      return sortedTree.filter((n) => !(n.kind === 'folder' && n.id === TRASH_ID));
    }
    return childrenOf(folderId, sortedTree);
  });

  // Apply free-text search. Empty query = no filter. Search runs against
  // the entire pool of notes when active so users can find things across
  // folders without drilling manually.
  const visible = $derived.by<TreeNode[]>(() => {
    const q = mobileState.searchQuery.trim().toLowerCase();
    if (!q) return nodes;

    if (mobileState.view === 'shared') return [];

    let pool: NoteSummary[];
    if (mobileState.view === 'trash') {
      pool = Object.values(tree.notesById).filter(
        (n) => n.trashed || n.parent_collection_id === TRASH_ID
      );
    } else if (mobileState.view === 'favourite') {
      const favSet = favourites.ids;
      pool = Object.values(tree.notesById).filter(
        (n) => favSet.has(n.id) && !n.trashed
      );
    } else {
      pool = Object.values(tree.notesById).filter(
        (n) => !n.trashed && n.parent_collection_id !== TRASH_ID
      );
    }
    return pool
      .filter((n) => n.title.toLowerCase().includes(q))
      .map<TreeNode>((n) => ({
        kind: 'note',
        id: n.id,
        name: n.title,
        position: n.position,
        parent_collection_id: n.parent_collection_id
      }));
  });

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
    if (mobileState.searchQuery.trim()) return 'No notes match this search.';
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
</script>

<div class="flex-1 overflow-y-auto px-3 py-3">
  {#if !tree.ready}
    <p class="px-1 py-2 text-sm text-muted-foreground">Loading…</p>
  {:else if tree.error}
    <p class="px-1 py-2 text-sm text-destructive">
      Couldn't load notes: {tree.error}
    </p>
  {:else if visible.length === 0}
    <p class="px-1 py-6 text-center text-sm text-muted-foreground">
      {emptyStateMessage()}
    </p>
  {:else if mobileState.displayMode === 'grid'}
    <div class="grid grid-cols-2 gap-2">
      {#each visible as node (node.kind + ':' + node.id)}
        {@const fav = node.kind === 'note' && isFavourite(node.id)}
        <!-- Wrapper is a div so the favourite-toggle button can sit inside
             alongside the primary tap target without nesting <button>s. -->
        <div
          class="relative h-32 rounded-lg border border-border bg-card shadow-sm"
        >
          <button
            type="button"
            class="flex h-full w-full flex-col items-start gap-1.5 rounded-lg p-3 text-left hover:bg-accent/50"
            onclick={() => handleNodeTap(node)}
          >
            {#if node.kind === 'folder'}
              <Folder class="size-5 text-muted-foreground" />
            {:else}
              <FileText class="size-5 text-muted-foreground" />
            {/if}
            <span class="line-clamp-2 pr-6 text-sm font-medium">{node.name}</span>
            {#if node.kind === 'note'}
              <span class="mt-auto text-[10px] text-muted-foreground">
                {previewFor(node.id)}
              </span>
            {/if}
          </button>
          {#if node.kind === 'note'}
            <button
              type="button"
              class="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:text-foreground"
              onclick={() => toggleFavourite(node.id)}
              aria-pressed={fav}
              aria-label={fav ? 'Remove from favourites' : 'Add to favourites'}
              title={fav ? 'Remove from favourites' : 'Add to favourites'}
            >
              <Star class="size-4" fill={fav ? 'currentColor' : 'none'} />
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {:else}
    <ul class="flex flex-col">
      {#each visible as node (node.kind + ':' + node.id)}
        {@const fav = node.kind === 'note' && isFavourite(node.id)}
        <li class="flex w-full items-center gap-1">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2.5 text-left hover:bg-accent"
            onclick={() => handleNodeTap(node)}
          >
            {#if node.kind === 'folder'}
              <Folder class="size-5 shrink-0 text-muted-foreground" />
            {:else}
              <FileText class="size-5 shrink-0 text-muted-foreground" />
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
              aria-label={fav ? 'Remove from favourites' : 'Add to favourites'}
              title={fav ? 'Remove from favourites' : 'Add to favourites'}
            >
              <Star class="size-4" fill={fav ? 'currentColor' : 'none'} />
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
