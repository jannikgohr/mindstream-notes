<script lang="ts">
  /**
   * Current-folder breadcrumb. Each segment is tappable to drill back
   * out — the trailing segment is rendered as plain text since you
   * can't navigate "to where you already are". The root segment always
   * carries a home icon so the chrome looks identical at the bucket
   * root and deep in a folder.
   *
   * Lives at the top of the note-view section (no bg-card chrome, no
   * outlined pill) so it reads as inline breadcrumb text floating over
   * the note background, with the sort + display toolbar immediately
   * below it.
   */
  import { Home, ChevronRight } from 'lucide-svelte';
  import { tree } from '$lib/stores/tree.svelte';
  import type { Collection } from '$lib/api';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { mobileState, setCurrentFolder, type MobileView } from './state.svelte';

  interface Segment {
    id: string | null;
    label: string;
  }

  function rootLabel(view: MobileView): string {
    return tUi(`breadcrumb.root.${view}`);
  }

  const segments = $derived.by<Segment[]>(() => {
    const out: Segment[] = [{ id: null, label: rootLabel(mobileState.view) }];

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
  class="flex h-8 shrink-0 items-center gap-1 overflow-x-auto px-3 pt-2 text-xs text-muted-foreground"
  aria-label={tUi('breadcrumb.label')}
>
  {#each segments as seg, i (i)}
    {@const isLast = i === segments.length - 1}
    {@const isRoot = i === 0}
    {#if i > 0}
      <ChevronRight class="size-3 shrink-0 opacity-50" />
    {/if}
    <!--
      Last-segment <span> and intermediate <button> use *identical*
      box chrome so the active segment doesn't jump rightward by
      ~4px when navigating into a subfolder (the root segment
      demotes from span to button at that moment). Only `truncate`
      lives on the inner text-<span> — putting it on the outer flex
      box clips the home icon's bleed.
    -->
    {#if isLast}
      <span
        class="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 font-medium text-foreground"
        aria-current="page"
      >
        {#if isRoot}
          <Home class="size-3.5 shrink-0" aria-hidden="true" />
        {/if}
        <span class="truncate">{seg.label}</span>
      </span>
    {:else}
      <button
        type="button"
        class="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-accent-foreground"
        onclick={() => setCurrentFolder(seg.id)}
      >
        {#if isRoot}
          <Home class="size-3.5 shrink-0" aria-hidden="true" />
        {/if}
        <span class="truncate">{seg.label}</span>
      </button>
    {/if}
  {/each}
</nav>
