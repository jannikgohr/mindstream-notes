<script lang="ts">
  /**
   * Two-factor sign-in: setting up an authenticator app, replacing it,
   * making new backup codes, and turning it off.
   *
   * Setting up is two steps on the server and three here. The server hands
   * out a secret, nothing changes until a code made from it comes back, and
   * then it issues backup codes, which have to be shown before the user
   * moves on.
   */
  import { Loader2 } from '@lucide/svelte';
  import {
    accountBeginAuthenticator,
    accountConfirmAuthenticator,
    accountNewBackupCodes,
    accountRemoveAuthenticator,
    type AuthenticatorSetup,
    type SecurityOverview
  } from '$lib/api/account';
  import { Button } from '$lib/components/ui/button';
  import { tUi, tUiFormat } from '$lib/settings/i18n.svelte';
  import ProofForm from './ProofForm.svelte';
  import SecretReveal from './SecretReveal.svelte';
  import { describeRefusal } from './refusal';
  import { FIELD_CLASS, FIELD_LABEL_CLASS } from './styles';

  interface Props {
    overview: SecurityOverview;
    onChanged: () => void;
  }

  let { overview, onChanged }: Props = $props();

  type Step = 'idle' | 'begin' | 'confirm' | 'codes' | 'backup' | 'remove';

  let step = $state<Step>('idle');
  let setup = $state<AuthenticatorSetup | null>(null);
  let confirmCode = $state('');
  let backupCodes = $state<string[]>([]);
  let busy = $state(false);
  let error = $state<string | null>(null);

  /** Replacing an authenticator takes a code from the old one, unless this
   *  device signed in with it. That exception is the way back for someone
   *  who lost the authenticator and still has a signed-in device. */
  const replaceNeedsCode = $derived(
    overview.authenticator && !overview.sessionVerified
  );

  const qrSource = $derived(
    setup ? `data:image/svg+xml;base64,${btoa(setup.qrSvg)}` : ''
  );

  function reset() {
    step = 'idle';
    setup = null;
    confirmCode = '';
    backupCodes = [];
    error = null;
  }

  async function begin(password: string, code: string) {
    setup = await accountBeginAuthenticator(password, code);
    step = 'confirm';
  }

  async function confirm() {
    if (busy || confirmCode.trim().length === 0) return;
    busy = true;
    error = null;
    try {
      backupCodes = await accountConfirmAuthenticator(confirmCode.trim());
      setup = null;
      step = 'codes';
    } catch (err) {
      error = describeRefusal(err);
    } finally {
      busy = false;
    }
  }

  async function replaceBackupCodes(password: string, code: string) {
    backupCodes = await accountNewBackupCodes(password, code);
    step = 'codes';
  }

  async function remove(password: string, code: string) {
    await accountRemoveAuthenticator(password, code);
    reset();
    onChanged();
  }

  function codesStored() {
    reset();
    onChanged();
  }
</script>

<div class="grid gap-2" data-testid="account-two-factor">
  <div>
    <div class="text-sm font-medium">{tUi('account.twoFactor.title')}</div>
    <p class="text-xs text-muted-foreground" data-testid="two-factor-status">
      {#if overview.authenticator}
        {tUiFormat('account.twoFactor.on', { count: overview.backupCodes })}
      {:else}
        {tUi('account.twoFactor.off')}
      {/if}
    </p>
  </div>

  {#if step === 'idle'}
    <div class="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" onclick={() => (step = 'begin')}>
        {tUi(
          overview.authenticator
            ? 'account.twoFactor.replace'
            : 'account.twoFactor.setUp'
        )}
      </Button>
      {#if overview.authenticator}
        <Button size="sm" variant="secondary" onclick={() => (step = 'backup')}>
          {tUi('account.twoFactor.newBackupCodes')}
        </Button>
        <Button size="sm" variant="ghost" onclick={() => (step = 'remove')}>
          {tUi('account.twoFactor.turnOff')}
        </Button>
      {/if}
    </div>
  {:else if step === 'begin'}
    <ProofForm
      explanation={tUi(
        replaceNeedsCode
          ? 'account.twoFactor.begin.replaceExplanation'
          : 'account.twoFactor.begin.explanation'
      )}
      needCode={replaceNeedsCode}
      submitLabel={tUi('account.continue')}
      onSubmit={begin}
      onCancel={reset}
    />
  {:else if step === 'confirm' && setup}
    <div
      class="rounded-md border border-border bg-background/60 p-3"
      data-testid="two-factor-confirm"
    >
      <form
        class="grid gap-2"
        onsubmit={(e) => {
          e.preventDefault();
          void confirm();
        }}
      >
        <p class="text-xs text-muted-foreground">
          {tUi('account.twoFactor.confirm.explanation')}
        </p>
        <img
          src={qrSource}
          alt={tUi('account.twoFactor.confirm.qrAlt')}
          class="size-44 rounded-md border border-border bg-white p-1"
        />
        <div class="grid gap-1">
          <span class={FIELD_LABEL_CLASS}>
            {tUi('account.twoFactor.confirm.secret')}
          </span>
          <code
            class="select-all break-all rounded-md border border-border bg-background p-2 font-mono text-xs"
            data-testid="two-factor-secret"
          >
            {setup.secret}
          </code>
        </div>
        <label class="grid gap-1">
          <span class={FIELD_LABEL_CLASS}>{tUi('account.code')}</span>
          <input
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            aria-label={tUi('account.code')}
            bind:value={confirmCode}
            disabled={busy}
            class="{FIELD_CLASS} font-mono"
          />
        </label>
        {#if error}
          <p class="text-xs text-destructive">{error}</p>
        {/if}
        <div class="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={busy || confirmCode.trim().length === 0}
          >
            <span class="inline-flex items-center">
              {#if busy}
                <Loader2 class="mr-1.5 size-3.5 animate-spin" />
              {/if}
              {tUi('account.twoFactor.confirm.submit')}
            </span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onclick={reset}
            disabled={busy}
          >
            {tUi('account.cancel')}
          </Button>
        </div>
      </form>
    </div>
  {:else if step === 'codes'}
    <SecretReveal
      title={tUi('account.reveal.backupCodes.title')}
      explanation={tUi('account.reveal.backupCodes.explanation')}
      lines={backupCodes}
      onDone={codesStored}
    />
  {:else if step === 'backup'}
    <ProofForm
      explanation={tUi('account.twoFactor.backup.explanation')}
      needCode={true}
      submitLabel={tUi('account.twoFactor.newBackupCodes')}
      onSubmit={replaceBackupCodes}
      onCancel={reset}
    />
  {:else if step === 'remove'}
    <ProofForm
      explanation={tUi('account.twoFactor.remove.explanation')}
      needCode={true}
      submitLabel={tUi('account.twoFactor.turnOff')}
      destructive={true}
      onSubmit={remove}
      onCancel={reset}
    />
  {/if}
</div>
