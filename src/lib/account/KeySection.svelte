<script lang="ts">
  /**
   * The account's own key, as digits. Someone who shares with this account
   * sees the same digits in their app if the server gave them the right
   * key, and other digits if it gave them one of its own.
   */
  import { onMount } from 'svelte';
  import { ownKeyFingerprint } from '$lib/api/sharing';
  import KeyFingerprint from '$lib/sharing/KeyFingerprint.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  let fingerprint = $state<string | null>(null);
  let failed = $state(false);

  onMount(async () => {
    try {
      fingerprint = await ownKeyFingerprint();
    } catch (err) {
      console.debug('[account] own key fingerprint', err);
      failed = true;
    }
  });
</script>

<div class="grid gap-2" data-testid="account-key">
  <div>
    <div class="text-sm font-medium">{tUi('account.key')}</div>
    <p class="text-xs text-muted-foreground">
      {tUi('account.key.explanation')}
    </p>
  </div>
  {#if fingerprint}
    <KeyFingerprint value={fingerprint} />
  {:else if failed}
    <p class="text-xs text-destructive">{tUi('account.key.unavailable')}</p>
  {/if}
</div>
