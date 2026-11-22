<script lang="ts">
  /**
   * Note-view controls beside the breadcrumb: the sort menu and the
   * list/grid switch, as ghost icons like the desktop file-tree header, so
   * the breadcrumb and the controls share one row above the list. Plugin
   * tab views, which have no tab bar to live in here, open from this row too.
   */
  import { LayoutGrid, List } from '@lucide/svelte';
  import SortControl from '$lib/components/SortControl.svelte';
  import { setSortDirection, setSortStrategy, ui } from '$lib/state.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import PluginIcon from '$lib/plugins/PluginIcon.svelte';
  import { resolvePluginString } from '$lib/plugins/plugin-i18n';
  import { pluginTabViews } from '$lib/plugins/registry.svelte';
  import {
    mobileState,
    navigateToTabView,
    setDisplayMode
  } from './state.svelte';
  import { tooltip } from '$lib/actions/tooltip';
</script>

<div class="touch-targets flex shrink-0 items-center gap-1">
  {#each pluginTabViews() as { pluginId, view } (`${pluginId}:${view.id}`)}
    {@const label = resolvePluginString(pluginId, view.labelKey)}
    <button
      type="button"
      class="flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent"
      onclick={() => navigateToTabView(pluginId, view.id)}
      aria-label={label}
      use:tooltip={label}
    >
      <PluginIcon {pluginId} file={view.icon} class="size-4" />
    </button>
  {/each}
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
      class="flex size-11 items-center justify-center rounded-md transition-colors {mobileState.displayMode ===
      'list'
        ? 'bg-accent-brand/10 text-accent-brand'
        : 'text-muted-foreground hover:bg-accent'}"
      onclick={() => setDisplayMode('list')}
      aria-pressed={mobileState.displayMode === 'list'}
      aria-label={tUi('display.list')}
      use:tooltip={tUi('display.list')}
    >
      <List class="size-4" />
    </button>
    <button
      type="button"
      class="flex size-11 items-center justify-center rounded-md transition-colors {mobileState.displayMode ===
      'grid'
        ? 'bg-accent-brand/10 text-accent-brand'
        : 'text-muted-foreground hover:bg-accent'}"
      onclick={() => setDisplayMode('grid')}
      aria-pressed={mobileState.displayMode === 'grid'}
      aria-label={tUi('display.grid')}
      use:tooltip={tUi('display.grid')}
    >
      <LayoutGrid class="size-4" />
    </button>
  </div>
</div>
