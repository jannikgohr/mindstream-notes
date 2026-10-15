<script lang="ts">
  /**
   * Shown in place of an invitation that was held back because the
   * recipient's key is not the one this device remembers. It says what that
   * means, shows both keys so they can be compared with the recipient over
   * another channel, and lets the user go on.
   *
   * Going on is only offered once the new key is on screen. Nobody should
   * trust a key they were not shown.
   */
  import { onMount } from 'svelte';
  import { TriangleAlert } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { userKeyInfo } from '$lib/api/sharing';
  import type { UserKey } from '$lib/api/sharing';
  import KeyFingerprint from '$lib/sharing/KeyFingerprint.svelte';
  import { tUi, tUiFormat } from '$lib/settings/i18n.svelte';

  interface Props {
    username: string;
    disabled?: boolean;
    onTrust: () => void;
  }

  let { username, disabled = false, onTrust }: Props = $props();

  let key = $state<UserKey | null>(null);
  let failed = $state(false);

  onMount(async () => {
    try {
      key = await userKeyInfo(username);
    } catch (err) {
      console.error('[sharing] read the key of', username, err);
      failed = true;
    }
  });
</script>

<div class="space-y-1.5 text-xs" data-testid="key-changed-notice">
  <p class="flex items-start gap-1.5 font-medium">
    <TriangleAlert class="mt-0.5 size-3.5 shrink-0" />
    <span>
      {tUiFormat('sharing.key.changed.recipient', { name: username })}
    </span>
  </p>
  <p>{tUiFormat('sharing.key.compare', { name: username })}</p>
  {#if key}
    <KeyFingerprint label={tUi('sharing.key.now')} value={key.fingerprint} />
    {#if key.known_fingerprint}
      <KeyFingerprint
        label={tUi('sharing.key.before')}
        value={key.known_fingerprint}
      />
    {/if}
  {:else if failed}
    <p>{tUi('sharing.key.loadFailed')}</p>
  {/if}
  <Button
    type="button"
    size="sm"
    variant="secondary"
    disabled={disabled || key === null}
    onclick={onTrust}
  >
    {tUi('sharing.key.trustAndInvite')}
  </Button>
</div>
