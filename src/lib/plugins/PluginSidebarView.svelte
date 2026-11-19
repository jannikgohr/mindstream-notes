<script lang="ts">
  /** The body of a plugin's sidebar view, drawn by the renderer it declares. */
  import PluginSchemaView from './PluginSchemaView.svelte';
  import type { PluginSidebarViewRef } from './registry.svelte';

  let { ref, source }: { ref: PluginSidebarViewRef; source: string } = $props();
</script>

{#key source}
  <PluginSchemaView {ref} {source} />
{/key}
