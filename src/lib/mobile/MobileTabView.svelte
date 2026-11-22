<script lang="ts">
  /**
   * A plugin's tab view as a full screen: a phone has no tab bar to put it
   * in. Back leaves it like it leaves a note.
   */
  import { ArrowLeft } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { resolvePluginString } from '$lib/plugins/plugin-i18n';
  import PluginTabView from '$lib/plugins/PluginTabView.svelte';
  import { pluginTabView } from '$lib/plugins/registry.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { navigateBack } from './state.svelte';

  let { pluginId, viewId }: { pluginId: string; viewId: string } = $props();

  const ref = $derived(pluginTabView(pluginId, viewId));
</script>

<div class="flex h-full w-full flex-col">
  <header
    class="touch-targets flex h-14 shrink-0 select-none items-center gap-1 border-b border-border bg-surface-0 px-1.5"
  >
    <Button
      variant="ghost"
      size="icon"
      onclick={navigateBack}
      title={tUi('mobile.back')}
      aria-label={tUi('mobile.back')}
    >
      <ArrowLeft class="size-5" />
    </Button>
    <h1 class="min-w-0 flex-1 truncate px-1 text-sm font-medium">
      {ref ? resolvePluginString(pluginId, ref.view.labelKey) : ''}
    </h1>
  </header>
  <main class="min-h-0 flex-1 overflow-hidden">
    <PluginTabView {pluginId} {viewId} />
  </main>
</div>
