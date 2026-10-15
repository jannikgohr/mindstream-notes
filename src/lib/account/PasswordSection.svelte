<script lang="ts">
  /**
   * Setting a new password from a device that is signed in.
   *
   * The old password is not asked for. A signed-in device is the way back
   * for someone who has forgotten it, and the device already holds the key
   * the old password stood for. A second factor, where there is one, is
   * asked for: it is what stops whoever picks up an unlocked device.
   */
  import { Loader2 } from '@lucide/svelte';
  import {
    accountChangePassword,
    type SecurityOverview
  } from '$lib/api/account';
  import { Button } from '$lib/components/ui/button';
  import { tUi, tUiFormat } from '$lib/settings/i18n.svelte';
  import { describeRefusal } from './refusal';
  import {
    FIELD_CLASS,
    FIELD_LABEL_CLASS,
    MIN_PASSWORD_LENGTH
  } from './styles';

  interface Props {
    overview: SecurityOverview;
    onChanged: () => void;
  }

  let { overview, onChanged }: Props = $props();

  let open = $state(false);
  let password = $state('');
  let passwordAgain = $state('');
  let code = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let changed = $state(false);

  const problem = $derived.by(() => {
    if (password.length === 0) return null;
    if (password.length < MIN_PASSWORD_LENGTH) {
      return tUiFormat('account.password.tooShort', {
        count: MIN_PASSWORD_LENGTH
      });
    }
    if (passwordAgain.length > 0 && password !== passwordAgain) {
      return tUi('account.password.mismatch');
    }
    return null;
  });

  const canSubmit = $derived(
    !busy &&
      password.length >= MIN_PASSWORD_LENGTH &&
      password === passwordAgain &&
      (!overview.authenticator || code.trim().length > 0)
  );

  function close() {
    open = false;
    password = '';
    passwordAgain = '';
    code = '';
    error = null;
  }

  async function submit() {
    if (!canSubmit) return;
    busy = true;
    error = null;
    try {
      await accountChangePassword(password, code);
      close();
      changed = true;
      onChanged();
    } catch (err) {
      error = describeRefusal(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="grid gap-2" data-testid="account-password">
  <div>
    <div class="text-sm font-medium">{tUi('account.password')}</div>
    <p class="text-xs text-muted-foreground">
      {tUi(
        changed
          ? 'account.password.changed'
          : 'account.password.changeExplanation'
      )}
    </p>
  </div>

  {#if !open}
    <div>
      <Button
        size="sm"
        variant="secondary"
        onclick={() => {
          open = true;
          changed = false;
        }}
      >
        {tUi('account.password.change')}
      </Button>
    </div>
  {:else}
    <div class="rounded-md border border-border bg-background/60 p-3">
      <form
        class="grid gap-2"
        onsubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label class="grid gap-1">
          <span class={FIELD_LABEL_CLASS}>{tUi('account.newPassword')}</span>
          <input
            type="password"
            autocomplete="new-password"
            aria-label={tUi('account.newPassword')}
            bind:value={password}
            disabled={busy}
            class={FIELD_CLASS}
          />
        </label>
        <label class="grid gap-1">
          <span class={FIELD_LABEL_CLASS}>{tUi('account.passwordAgain')}</span>
          <input
            type="password"
            autocomplete="new-password"
            aria-label={tUi('account.passwordAgain')}
            bind:value={passwordAgain}
            disabled={busy}
            class={FIELD_CLASS}
          />
        </label>
        {#if overview.authenticator}
          <label class="grid gap-1">
            <span class={FIELD_LABEL_CLASS}>{tUi('account.code')}</span>
            <input
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              aria-label={tUi('account.code')}
              bind:value={code}
              disabled={busy}
              class="{FIELD_CLASS} font-mono"
            />
            <span class="text-xs text-muted-foreground">
              {tUi('account.code.hint')}
            </span>
          </label>
        {/if}
        {#if problem || error}
          <p class="text-xs text-destructive">{problem ?? error}</p>
        {/if}
        <div class="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={!canSubmit}>
            <span class="inline-flex items-center">
              {#if busy}
                <Loader2 class="mr-1.5 size-3.5 animate-spin" />
              {/if}
              {tUi('account.password.change')}
            </span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onclick={close}
            disabled={busy}
          >
            {tUi('account.cancel')}
          </Button>
        </div>
      </form>
    </div>
  {/if}
</div>
