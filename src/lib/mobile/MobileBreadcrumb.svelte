<script lang="ts">
  /**
   * Current-folder breadcrumb. Each segment is tappable to drill back
   * out — the trailing segment is rendered as plain text since you
   * can't navigate "to where you already are". The root segment carries
   * the active view's icon so the breadcrumb matches the bottom nav.
   *
   * Lives at the top of the note-view section (no bg-card chrome, no
   * outlined pill) so it reads as inline breadcrumb text floating over
   * the note background, with the sort + display toolbar immediately
   * below it.
   */
  import { ChevronRight, Home, Share2, Star, Trash2 } from '@lucide/svelte';
  import { tree } from '$lib/stores/tree.svelte';
  import { TRASH_ID, type Collection } from '$lib/api';
  import type { IconComponent } from '$lib/settings/icons';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    mobileState,
    setCurrentFolder,
    type MobileView
  } from './state.svelte';

  interface Segment {
    id: string | null;
    label: string;
  }

  function rootLabel(view: MobileView): string {
    return tUi(`breadcrumb.root.${view}`);
  }

  const rootIcon = $derived.by<IconComponent>(() => {
    switch (mobileState.view) {
      case 'shared':
        return Share2 as unknown as IconComponent;
      case 'favourite':
        return Star as unknown as IconComponent;
      case 'trash':
        return Trash2 as unknown as IconComponent;
      default:
        return Home as unknown as IconComponent;
    }
  });

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
    for (const c of chain) {
      if (mobileState.view === 'trash' && c.id === TRASH_ID) continue;
      out.push({ id: c.id, label: c.name });
    }
    return out;
  });
</script>

<!-- The path sits in one chip whose edge lines up with the rows' hover
     background below, so the list and its location read as one column. The
     chip scrolls sideways when the path is long. -->
<nav class="flex min-w-0 flex-1" aria-label={tUi('breadcrumb.label')}>
  <div
    class="scrollbar-none inline-flex h-8 min-w-0 max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-border bg-surface-3 pl-2.5 pr-3 text-xs text-muted-foreground shadow-raised"
  >
    {#each segments as seg, i (i)}
      {@const isLast = i === segments.length - 1}
      {@const isRoot = i === 0}
      {@const RootIcon = rootIcon}
      {#if i > 0}
        <ChevronRight class="size-3 shrink-0 opacity-50" />
      {/if}
      <!-- The last segment's <span> and the ancestors' <button>s share box
           chrome, so a segment does not shift when it turns from current into
           an ancestor. `truncate` lives on the inner text only, so the icon
           is never clipped. -->
      {#if isLast}
        <span
          class="flex min-w-0 shrink-0 items-center gap-1.5 rounded-full py-0.5 font-medium text-foreground {isRoot
            ? 'pr-0.5'
            : 'px-1'}"
          aria-current="page"
        >
          {#if isRoot}
            <RootIcon class="size-3.5 shrink-0" aria-hidden="true" />
          {/if}
          <span class="max-w-40 truncate">{seg.label}</span>
        </span>
      {:else}
        <button
          type="button"
          class="flex min-w-0 shrink-0 items-center gap-1.5 rounded-full py-0.5 hover:text-foreground {isRoot
            ? 'pr-0.5'
            : 'px-1'}"
          onclick={() => setCurrentFolder(seg.id)}
        >
          {#if isRoot}
            <RootIcon class="size-3.5 shrink-0" aria-hidden="true" />
          {/if}
          <span class="max-w-28 truncate">{seg.label}</span>
        </button>
      {/if}
    {/each}
  </div>
</nav>
