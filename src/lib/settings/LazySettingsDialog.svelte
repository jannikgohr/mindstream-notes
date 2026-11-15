<script lang="ts">
  import { settingsDialog } from './store.svelte';
  import { createLazyComponent } from '$lib/components/lazy-component.svelte';

  const settings = createLazyComponent({
    load: () => import('./SettingsDialog.svelte'),
    when: () => settingsDialog.open
  });
</script>

{#if settings.component}
  <settings.component />
{/if}
