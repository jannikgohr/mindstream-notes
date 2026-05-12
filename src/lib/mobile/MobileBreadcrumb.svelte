<script lang="ts">
  /**
   * Current-folder breadcrumb. Each segment (including the implicit root)
   * is tappable to drill back out — last segment is rendered as plain
   * text since you can't navigate "to where you already are".
   */
  import { ChevronRight } from 'lucide-svelte';
  import { tree } from '$lib/stores/tree.svelte';
  import type { Collection } from '$lib/api';
  import { mobileState, setCurrentFolder } from './state.svelte';

  interface Segment {
    id: string | null;
    label: string;
  }

  const ROOT_LABELS: Record<string, string> = {
    home: 'Notes',
    shared: 'Shared',
    favourite: 'Favourites',
    trash: 'Trash'
  };

  const segments = $derived.by<Segment[]>(() => {
    const rootLabel = ROOT_LABELS[mobileState.view] ?? 'Notes';
    const out: Segment[] = [{ id: null, label: rootLabel }];

    let id = mobileState.currentFolderId;
    const chain: Collection[] = [];
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      const c = tree.collectionsById[id];
      if (!c) break;
      chain.unshift(c);
      id = c.parent_collection_id;
    }
    for (const c of chain) out.push({ id: c.id, label: c.name });
    return out;
  });
</script>

<nav
  class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card px-3 py-2 text-xs text-muted-foreground"
  aria-label="Folder path"
>
  {#each segments as seg, i (i)}
    {#if i > 0}
      <ChevronRight class="size-3 shrink-0 opacity-50" />
    {/if}
    {#if i === segments.length - 1}
      <span class="truncate font-medium text-foreground" aria-current="page">
        {seg.label}
      </span>
    {:else}
      <button
        type="button"
        class="truncate rounded px-1 py-0.5 hover:bg-accent hover:text-accent-foreground"
        onclick={() => setCurrentFolder(seg.id)}
      >
        {seg.label}
      </button>
    {/if}
  {/each}
</nav>
