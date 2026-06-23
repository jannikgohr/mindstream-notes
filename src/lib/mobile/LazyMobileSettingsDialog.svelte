<script lang="ts">
  import { settingsDialog } from '$lib/settings/store.svelte';

  let MobileSettingsDialog = $state<any | null>(null);
  let loadToken = 0;

  $effect(() => {
    const active = settingsDialog.open;
    const token = ++loadToken;
    if (!active) {
      MobileSettingsDialog = null;
      return;
    }
    void import('./MobileSettingsDialog.svelte').then((mod) => {
      if (token === loadToken && settingsDialog.open) {
        MobileSettingsDialog = mod.default;
      }
    });
  });
</script>

{#if MobileSettingsDialog}
  <MobileSettingsDialog />
{/if}
