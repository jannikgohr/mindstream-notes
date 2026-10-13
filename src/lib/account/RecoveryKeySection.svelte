<script lang="ts">
  /**
   * The recovery key: whether the account has one, and making a new one.
   *
   * A key cannot be shown again, only replaced. So "I lost my recovery key"
   * and "I never wrote it down" both end here, as long as the user still
   * knows the password.
   */
  import {
    accountNewRecoveryKey,
    type SecurityOverview
  } from '$lib/api/account';
  import { authSession } from '$lib/api/auth.svelte';
  import { Button } from '$lib/components/ui/button';
  import { tUi } from '$lib/settings/i18n.svelte';
  import ProofForm from './ProofForm.svelte';
  import { recoveryKeyFile } from './recovery-key-file';
  import SecretReveal from './SecretReveal.svelte';

  interface Props {
    overview: SecurityOverview;
    onChanged: () => void;
  }

  let { overview, onChanged }: Props = $props();

  type Step = 'idle' | 'prove' | 'reveal';

  let step = $state<Step>('idle');
  let key = $state('');

  async function replace(password: string, code: string) {
    key = await accountNewRecoveryKey(password, code);
    step = 'reveal';
  }

  function stored() {
    key = '';
    step = 'idle';
    onChanged();
  }
</script>

<div class="grid gap-2" data-testid="account-recovery-key">
  <div>
    <div class="text-sm font-medium">{tUi('account.recoveryKey')}</div>
    <p class="text-xs text-muted-foreground" data-testid="recovery-key-status">
      {tUi(
        overview.recoveryKey
          ? 'account.recoveryKey.set'
          : 'account.recoveryKey.none'
      )}
    </p>
  </div>

  {#if step === 'idle'}
    <div>
      <Button size="sm" variant="secondary" onclick={() => (step = 'prove')}>
        {tUi('account.recoveryKey.create')}
      </Button>
    </div>
  {:else if step === 'prove'}
    <ProofForm
      explanation={tUi(
        overview.recoveryKey
          ? 'account.recoveryKey.replaceExplanation'
          : 'account.recoveryKey.createExplanation'
      )}
      needCode={overview.authenticator}
      submitLabel={tUi('account.recoveryKey.create')}
      onSubmit={replace}
      onCancel={() => (step = 'idle')}
    />
  {:else}
    <SecretReveal
      title={tUi('account.reveal.recoveryKey.title')}
      explanation={tUi('account.reveal.recoveryKey.explanation')}
      lines={[key]}
      file={recoveryKeyFile(key, authSession.current)}
      onDone={stored}
    />
  {/if}
</div>
