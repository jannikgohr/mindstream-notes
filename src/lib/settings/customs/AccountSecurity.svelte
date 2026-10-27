<script lang="ts">
  /**
   * Account security: two-factor sign-in, the recovery key, the password
   * and the devices signed in. Mounted under the sign-in form (see
   * schema.json), and empty until someone is signed in.
   *
   * Everything shown comes from the server each time the settings dialog
   * opens, because any of it can change from another device.
   */
  import { Loader2 } from '@lucide/svelte';
  import {
    accountSecurityStatus,
    type SecurityOverview
  } from '$lib/api/account';
  import { authSession } from '$lib/api/auth.svelte';
  import DevicesSection from '$lib/account/DevicesSection.svelte';
  import KeySection from '$lib/account/KeySection.svelte';
  import PasswordSection from '$lib/account/PasswordSection.svelte';
  import RecoveryKeySection from '$lib/account/RecoveryKeySection.svelte';
  import TwoFactorSection from '$lib/account/TwoFactorSection.svelte';
  import { describeRefusal } from '$lib/account/refusal';
  import { Button } from '$lib/components/ui/button';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { settingsDialog } from '../store.svelte';

  let overview = $state<SecurityOverview | null>(null);
  let error = $state<string | null>(null);
  /** Counts changes that may have ended other devices' sessions, so the
   *  device list asks again. */
  let revision = $state(0);

  async function load() {
    try {
      overview = await accountSecurityStatus();
      error = null;
    } catch (err) {
      overview = null;
      error = describeRefusal(err);
    }
  }

  function changed() {
    revision += 1;
    void load();
  }

  $effect(() => {
    if (settingsDialog.open && authSession.current) void load();
    else overview = null;
  });
</script>

<div
  class="min-w-0 rounded-md border border-border bg-muted/40 p-3 text-sm [overflow-wrap:anywhere]"
  data-testid="account-security"
>
  {#if !authSession.current}
    <p class="text-xs text-muted-foreground">
      {tUi('account.security.signedOut')}
    </p>
  {:else if overview}
    <div class="grid grid-cols-1 gap-4">
      <TwoFactorSection {overview} onChanged={changed} />
      <RecoveryKeySection {overview} onChanged={changed} />
      <PasswordSection {overview} onChanged={changed} />
      <KeySection />
      <DevicesSection {revision} />
    </div>
  {:else if error}
    <div class="grid gap-2">
      <p class="text-xs text-destructive">{error}</p>
      <div>
        <Button size="sm" variant="secondary" onclick={load}>
          {tUi('account.security.retry')}
        </Button>
      </div>
    </div>
  {:else}
    <div class="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 class="size-3.5 animate-spin" />
      {tUi('account.security.loading')}
    </div>
  {/if}
</div>
