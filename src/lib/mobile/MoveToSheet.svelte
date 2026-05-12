<script lang="ts">
  /**
   * Folder picker rendered as a full-bleed bottom sheet. Walks the
   * collection tree (skipping trash and any folder that would create a
   * cycle for the moving folder), indenting children so the hierarchy
   * stays readable. Tapping a destination invokes onPick and closes
   * the sheet.
   */
  import { ChevronRight, FolderClosed, FolderRoot, X } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import { TRASH_ID } from '$lib/api';
  import type { Collection } from '$lib/api';
  import { tree } from '$lib/stores/tree.svelte';

  export interface MoveTarget {
    kind: 'note' | 'folder';
    id: string;
    /** Current parent id of the item being moved — disabled in the list. */
    currentParent: string | null;
  }

  interface Props {
    target: MoveTarget;
    onPick: (destination: string | null) => void;
    onClose: () => void;
  }
  let { target, onPick, onClose }: Props = $props();

  interface Row {
    id: string;
    name: string;
    depth: number;
    /** Folder is invalid as a destination for the target item. */
    disabled: boolean;
    /** Why it's disabled — for the title attribute. */
    reason?: string;
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

  const rows = $derived.by<Row[]>(() => {
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

    const out: Row[] = [];
    function walk(parent: string | null, depth: number) {
      for (const c of byParent.get(parent) ?? []) {
        const isForbidden = forbidden.has(c.id);
        const isCurrent = target.currentParent === c.id;
        out.push({
          id: c.id,
          name: c.name,
          depth,
          disabled: isForbidden || isCurrent,
          reason: isForbidden
            ? 'Cannot move a folder into itself or one of its children'
            : isCurrent
              ? 'Already in this folder'
              : undefined
        });
        walk(c.id, depth + 1);
      }
    }
    walk(null, 0);
    return out;
  });

  const rootDisabled = $derived(target.currentParent === null);

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

  <div class="flex-1 overflow-y-auto py-2">
    <button
      type="button"
      class="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      disabled={rootDisabled}
      title={rootDisabled ? 'Already at root' : 'Move to root'}
      onclick={() => pick(null)}
    >
      <FolderRoot class="size-4 shrink-0 text-muted-foreground" />
      <span class="font-medium">Root</span>
    </button>

    {#if rows.length === 0}
      <p class="px-3 py-4 text-center text-xs text-muted-foreground">
        No other folders yet — create one from the home screen first.
      </p>
    {/if}

    {#each rows as row (row.id)}
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        style="padding-left: calc(0.75rem + {row.depth} * 1rem);"
        disabled={row.disabled}
        title={row.reason}
        onclick={() => pick(row.id)}
      >
        {#if row.depth > 0}
          <ChevronRight class="size-3 shrink-0 text-muted-foreground" />
        {/if}
        <FolderClosed class="size-4 shrink-0 text-muted-foreground" />
        <span class="truncate">{row.name}</span>
      </button>
    {/each}
  </div>
</div>
