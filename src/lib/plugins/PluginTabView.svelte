<script lang="ts">
  /** A plugin tab view's body, while its plugin is on. */
  import { tUi } from '$lib/settings/i18n.svelte';
  import PluginSchemaView from './PluginSchemaView.svelte';
  import { pluginTabView } from './registry.svelte';
  import { tabViewPanelId } from './tab-views';

  let { pluginId, viewId }: { pluginId: string; viewId: string } = $props();

  const ref = $derived(pluginTabView(pluginId, viewId));
</script>

<div class="flex h-full min-h-0 flex-col bg-background">
  {#if ref}
    {#key ref.view}
      <PluginSchemaView {ref} source={tabViewPanelId(pluginId, viewId)} tab />
    {/key}
  {:else}
    <p class="p-6 text-sm text-muted-foreground">
      {tUi('plugins.tabViewMissing')}
    </p>
  {/if}
</div>
