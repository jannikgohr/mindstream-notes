<script lang="ts">
  /**
   * Folder picker rendered as a full-bleed bottom sheet. The collection
   * tree is rendered recursively from a synthetic "Root" node so the
   * top-level acts like any other parent. Folders that contain other
   * folders get a chevron toggle; leaf folders show a fixed-width spacer
   * so all rows align. Tapping the body of any folder picks it as the
   * destination — the chevron is the only opt-in for expand/collapse.
   *
   * Disabled rules:
   *   - target.currentParent (already there → no-op move)
   *   - When moving a folder: the folder itself + all its descendants
   *     (a folder can't become its own ancestor).
   */
  import { ChevronRight, FolderClosed, FolderOpen, FolderRoot, X } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import { TRASH_ID } from '$lib/api';
  import type { Collection } from '$lib/api';
  import { tree } from '$lib/stores/tree.svelte';

  export interface MoveTarget {
    kind: 'note' | 'folder';
    id: string;
    /** Current parent id of the item being moved — disabled in the tree. */
    currentParent: string | null;
  }

  interface Props {
    target: MoveTarget;
    onPick: (destination: string | null) => void;
    onClose: () => void;
  }
  let { target, onPick, onClose }: Props = $props();

  interface FolderNode {
    id: string;
    name: string;
    children: FolderNode[];
  }

  /**
   * Set of folder ids that are descendants of `rootId` (inclusive). Used
   * to forbid moving a folder into itself or any of its children.
   */
  function descendants(rootId: string): Set<string> {
    const out = new Set<string>([rootId]);
    let added = true;
    while (added) {
      added = false;
      for (const c of Object.values(tree.collectionsById)) {
        if (
          c.parent_collection_id &&
          out.has(c.parent_collection_id) &&
          !out.has(c.id)
        ) {
          out.add(c.id);
          added = true;
        }
      }
    }
    return out;
  }

  const forbidden = $derived.by<Set<string>>(() => {
    if (target.kind === 'folder') return descendants(target.id);
    return new Set();
  });

  /**
   * Build the folder hierarchy as a `FolderNode` tree, sorted by name
   * at every level. The trash collection is filtered out — it isn't a
   * legal destination from this dialog.
   */
  const forest = $derived.by<FolderNode[]>(() => {
    const byParent = new Map<string | null, Collection[]>();
    for (const c of Object.values(tree.collectionsById)) {
      if (c.id === TRASH_ID) continue;
      const list = byParent.get(c.parent_collection_id) ?? [];
      list.push(c);
      byParent.set(c.parent_collection_id, list);
    }
    for (const list of byParent.values()) {
      list.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      );
    }
    function build(parent: string | null): FolderNode[] {
      return (byParent.get(parent) ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        children: build(c.id)
      }));
    }
    return build(null);
  });

  /**
   * Per-folder open/closed state. Initialised to expand the chain
   * leading to the current parent so the user can immediately see
   * where the item lives now. The synthetic "root" key is always
   * considered open and isn't stored here.
   */
  function initialExpanded(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    let id = target.currentParent;
    while (id) {
      out[id] = true;
      const parent = tree.collectionsById[id]?.parent_collection_id ?? null;
      id = parent;
    }
    return out;
  }
  let expanded = $state<Record<string, boolean>>(initialExpanded());

  function toggle(id: string) {
    expanded[id] = !expanded[id];
  }

  function disabledReason(id: string | null): string | null {
    if (target.currentParent === id) return 'Already in this folder';
    if (id !== null && forbidden.has(id)) {
      return 'Cannot move a folder into itself or one of its children';
    }
    return null;
  }

  function pick(destination: string | null) {
    onPick(destination);
    onClose();
  }
</script>

<button
  type="button"
  aria-label="Close folder picker"
  class="fixed inset-0 z-40 bg-black/40"
  onclick={onClose}
></button>

<div
  class="safe-bottom safe-x fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col rounded-t-xl border border-border bg-card shadow-2xl"
  role="dialog"
  aria-modal="true"
  aria-label="Move to folder"
>
  <header class="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
    <span class="text-sm font-semibold">Move to…</span>
    <Button
      variant="ghost"
      size="icon"
      onclick={onClose}
      title="Close"
      aria-label="Close"
    >
      <X class="size-5" />
    </Button>
  </header>

  <div class="flex-1 overflow-y-auto py-2" role="tree" aria-label="Folders">
    {@render row({
      id: null,
      name: 'Root',
      depth: 0,
      hasChildren: forest.length > 0,
      isRoot: true,
      open: true
    })}

    {#each forest as node (node.id)}
      {@render folderTree(node, 1)}
    {/each}
  </div>
</div>

{#snippet folderTree(node: FolderNode, depth: number)}
  {@const open = expanded[node.id] === true}
  {@render row({
    id: node.id,
    name: node.name,
    depth,
    hasChildren: node.children.length > 0,
    isRoot: false,
    open
  })}
  {#if open && node.children.length > 0}
    {#each node.children as child (child.id)}
      {@render folderTree(child, depth + 1)}
    {/each}
  {/if}
{/snippet}

{#snippet row(args: {
  id: string | null;
  name: string;
  depth: number;
  hasChildren: boolean;
  isRoot: boolean;
  open: boolean;
})}
  {@const reason = disabledReason(args.id)}
  {@const isDisabled = reason !== null}
  <div
    class="flex w-full items-stretch"
    style="padding-left: calc({args.depth} * 1rem);"
    role="treeitem"
    aria-selected="false"
    aria-expanded={args.hasChildren ? args.open : undefined}
    aria-disabled={isDisabled}
  >
    {#if args.hasChildren && !args.isRoot}
      <button
        type="button"
        class="flex w-7 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
        onclick={() => toggle(args.id as string)}
        aria-label={args.open ? 'Collapse folder' : 'Expand folder'}
        title={args.open ? 'Collapse' : 'Expand'}
      >
        <ChevronRight class="size-4 transition-transform {args.open ? 'rotate-90' : ''}" />
      </button>
    {:else}
      <!-- Spacer so leaf rows align with the icon column of expandable
           siblings. The root node skips the chevron column entirely. -->
      {#if !args.isRoot}
        <div class="w-7 shrink-0" aria-hidden="true"></div>
      {/if}
    {/if}

    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      disabled={isDisabled}
      title={reason ?? (args.isRoot ? 'Move to root' : `Move to ${args.name}`)}
      onclick={() => pick(args.id)}
    >
      {#if args.isRoot}
        <FolderRoot class="size-4 shrink-0 text-muted-foreground" />
      {:else if args.open && args.hasChildren}
        <FolderOpen class="size-4 shrink-0 text-muted-foreground" />
      {:else}
        <FolderClosed class="size-4 shrink-0 text-muted-foreground" />
      {/if}
      <span class="truncate {args.isRoot ? 'font-semibold' : 'font-medium'}">
        {args.name}
      </span>
    </button>
  </div>
{/snippet}
