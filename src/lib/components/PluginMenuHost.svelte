<script lang="ts">
  /**
   * Root-mounted host that renders the shared `ContextMenu` for a plugin's
   * `openMenu` effect (see `plugin-menu.svelte`). One instance for the whole
   * app; the effect runner fills the store and this shows it.
   */
  import ContextMenu from './ContextMenu.svelte';
  import { pluginMenu, closePluginMenu } from '$lib/plugins/plugin-menu.svelte';
</script>

{#if pluginMenu.open}
  <ContextMenu
    x={pluginMenu.x}
    y={pluginMenu.y}
    items={pluginMenu.items}
    onClose={closePluginMenu}
  />
{/if}
