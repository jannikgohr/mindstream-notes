<script lang="ts">
  /**
   * Below-breadcrumb toolbar: sort picker on the left, list/grid switcher
   * on the right. Sort strategy is read from the shared UI store so the
   * choice carries across platforms; display mode is mobile-local.
   */
  import { ArrowDownAZ, LayoutGrid, List } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import ContextMenu, { type MenuItem } from '$lib/components/ContextMenu.svelte';
  import { SORT_STRATEGIES, type SortStrategy } from '$lib/sort';
  import { setSortStrategy, ui } from '$lib/state.svelte';
  import { mobileState, setDisplayMode } from './state.svelte';

  let sortMenuOpen = $state(false);
  let sortMenuX = $state(0);
  let sortMenuY = $state(0);

  const currentSortLabel = $derived(
    SORT_STRATEGIES.find((s) => s.id === ui.sortStrategy)?.label ?? 'Sort'
  );

  function openSortMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    sortMenuX = r.left;
    sortMenuY = r.bottom + 4;
    sortMenuOpen = true;
  }

  function sortMenuItems(): (MenuItem | 'separator')[] {
    return SORT_STRATEGIES.map((opt) => ({
      label: (ui.sortStrategy === opt.id ? '✓  ' : '    ') + opt.label,
      onSelect: () => setSortStrategy(opt.id as SortStrategy)
    }));
  }
</script>

<div
  class="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-3 py-2"
>
  <Button
    variant="ghost"
    size="sm"
    onclick={openSortMenu}
    aria-label="Sort"
    class="h-8 gap-1.5 text-xs"
  >
    <ArrowDownAZ class="size-3.5" />
    <span class="truncate">{currentSortLabel}</span>
  </Button>

  <div
    class="inline-flex items-center rounded-md border border-border bg-background p-0.5"
    role="group"
    aria-label="Display mode"
  >
    <button
      type="button"
      class="flex size-7 items-center justify-center rounded-sm transition-colors {mobileState.displayMode ===
      'list'
        ? 'bg-accent text-accent-foreground'
        : 'text-muted-foreground hover:bg-accent/50'}"
      onclick={() => setDisplayMode('list')}
      aria-pressed={mobileState.displayMode === 'list'}
      aria-label="List view"
      title="List view"
    >
      <List class="size-3.5" />
    </button>
    <button
      type="button"
      class="flex size-7 items-center justify-center rounded-sm transition-colors {mobileState.displayMode ===
      'grid'
        ? 'bg-accent text-accent-foreground'
        : 'text-muted-foreground hover:bg-accent/50'}"
      onclick={() => setDisplayMode('grid')}
      aria-pressed={mobileState.displayMode === 'grid'}
      aria-label="Grid view"
      title="Grid view"
    >
      <LayoutGrid class="size-3.5" />
    </button>
  </div>
</div>

{#if sortMenuOpen}
  <ContextMenu
    x={sortMenuX}
    y={sortMenuY}
    items={sortMenuItems()}
    onClose={() => (sortMenuOpen = false)}
  />
{/if}
