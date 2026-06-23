<script lang="ts">
  import { settingsDialog } from './store.svelte';

  let SettingsDialog = $state<any | null>(null);
  let loadToken = 0;

  $effect(() => {
    const active = settingsDialog.open;
    const token = ++loadToken;
    if (!active) {
      SettingsDialog = null;
      return;
    }
    void import('./SettingsDialog.svelte').then((mod) => {
      if (token === loadToken && settingsDialog.open) {
        SettingsDialog = mod.default;
      }
    });
  });
</script>

{#if SettingsDialog}
  <SettingsDialog />
{/if}
