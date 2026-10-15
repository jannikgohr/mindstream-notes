<script lang="ts">
  /**
   * Asks for the password again, and for a code where the account has a
   * second factor, before something that changes how the account is
   * protected. The server checks both, so a refusal comes back from there
   * and is shown here.
   */
  import { Loader2 } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { describeRefusal } from './refusal';
  import { FIELD_CLASS, FIELD_LABEL_CLASS } from './styles';

  interface Props {
    /** What is about to happen, in a sentence. */
    explanation: string;
    needCode: boolean;
    submitLabel: string;
    destructive?: boolean;
    onSubmit: (password: string, code: string) => Promise<void>;
    onCancel: () => void;
  }

  let {
    explanation,
    needCode,
    submitLabel,
    destructive = false,
    onSubmit,
    onCancel
  }: Props = $props();

  let password = $state('');
  let code = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  const canSubmit = $derived(
    !busy && password.length > 0 && (!needCode || code.trim().length > 0)
  );

  async function submit() {
    if (!canSubmit) return;
    busy = true;
    error = null;
    try {
      await onSubmit(password, code.trim());
    } catch (err) {
      error = describeRefusal(err);
    } finally {
      busy = false;
    }
  }
</script>

<div
  class="rounded-md border border-border bg-background/60 p-3"
  data-testid="account-proof-form"
>
  <form
    class="grid gap-2"
    onsubmit={(e) => {
      e.preventDefault();
      void submit();
    }}
  >
    <p class="text-xs text-muted-foreground">{explanation}</p>
    <label class="grid gap-1">
      <span class={FIELD_LABEL_CLASS}>{tUi('account.password')}</span>
      <input
        type="password"
        autocomplete="current-password"
        aria-label={tUi('account.password')}
        bind:value={password}
        disabled={busy}
        class={FIELD_CLASS}
      />
    </label>
    {#if needCode}
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
    {#if error}
      <p class="text-xs text-destructive" data-testid="account-proof-error">
        {error}
      </p>
    {/if}
    <div class="flex items-center gap-2">
      <Button
        type="submit"
        size="sm"
        variant={destructive ? 'destructive' : 'default'}
        disabled={!canSubmit}
      >
        <span class="inline-flex items-center">
          {#if busy}
            <Loader2 class="mr-1.5 size-3.5 animate-spin" />
          {/if}
          {submitLabel}
        </span>
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onclick={onCancel}
        disabled={busy}
      >
        {tUi('account.cancel')}
      </Button>
    </div>
  </form>
</div>
