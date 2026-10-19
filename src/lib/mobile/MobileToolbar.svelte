<script lang="ts">
  /**
   * Note-view controls beside the breadcrumb: the sort menu and the
   * list/grid switch, as ghost icons like the desktop file-tree header, so
   * the breadcrumb and the controls share one row above the list.
   */
  import { LayoutGrid, List } from '@lucide/svelte';
  import SortControl from '$lib/components/SortControl.svelte';
  import { setSortDirection, setSortStrategy, ui } from '$lib/state.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { mobileState, setDisplayMode } from './state.svelte';
</script>

<div class="flex shrink-0 items-center gap-1">
  <SortControl
    strategy={ui.sortStrategy}
    direction={ui.sortDirection}
    onStrategyChange={setSortStrategy}
    onDirectionChange={setSortDirection}
    variant="ghost"
    collapsed
  />

  <div
    class="inline-flex items-center gap-0.5"
    role="group"
    aria-label={tUi('display.mode')}
  >
    <button
      type="button"
      class="flex size-8 items-center justify-center rounded-md transition-colors {mobileState.displayMode ===
      'list'
        ? 'bg-accent-brand/10 text-accent-brand'
        : 'text-muted-foreground hover:bg-accent'}"
      onclick={() => setDisplayMode('list')}
      aria-pressed={mobileState.displayMode === 'list'}
      aria-label={tUi('display.list')}
      title={tUi('display.list')}
    >
      <List class="size-4" />
    </button>
    <button
      type="button"
      class="flex size-8 items-center justify-center rounded-md transition-colors {mobileState.displayMode ===
      'grid'
        ? 'bg-accent-brand/10 text-accent-brand'
        : 'text-muted-foreground hover:bg-accent'}"
      onclick={() => setDisplayMode('grid')}
      aria-pressed={mobileState.displayMode === 'grid'}
      aria-label={tUi('display.grid')}
      title={tUi('display.grid')}
    >
      <LayoutGrid class="size-4" />
    </button>
  </div>
</div>
