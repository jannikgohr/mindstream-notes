<script lang="ts">
  /**
   * Below-breadcrumb toolbar: split sort control on the left, list/grid
   * switcher on the right. The sort strategy + direction are read from
   * the shared UI store so the choice carries across platforms; display
   * mode is mobile-local.
   */
  import { LayoutGrid, List } from 'lucide-svelte';
  import SortControl from '$lib/components/SortControl.svelte';
  import {
    setSortDirection,
    setSortStrategy,
    ui
  } from '$lib/state.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { mobileState, setDisplayMode } from './state.svelte';
</script>

<div
  class="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-3 pb-2 pt-1"
>
  <SortControl
    strategy={ui.sortStrategy}
    direction={ui.sortDirection}
    onStrategyChange={setSortStrategy}
    onDirectionChange={setSortDirection}
  />

  <div
    class="inline-flex items-center rounded-md border border-border bg-background p-0.5"
    role="group"
    aria-label={tUi('display.mode')}
  >
    <button
      type="button"
      class="flex size-7 items-center justify-center rounded-sm transition-colors {mobileState.displayMode ===
      'list'
        ? 'bg-accent text-accent-foreground'
        : 'text-muted-foreground hover:bg-accent/50'}"
      onclick={() => setDisplayMode('list')}
      aria-pressed={mobileState.displayMode === 'list'}
      aria-label={tUi('display.list')}
      title={tUi('display.list')}
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
      aria-label={tUi('display.grid')}
      title={tUi('display.grid')}
    >
      <LayoutGrid class="size-3.5" />
    </button>
  </div>
</div>
