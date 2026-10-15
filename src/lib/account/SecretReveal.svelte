<script lang="ts">
  /**
   * Shows something the user has to keep and will not be shown again: a
   * recovery key, or a set of backup codes.
   *
   * The way on is closed until they say they have stored it. That is the
   * whole point of the component: the server cannot show either a second
   * time, so a click-through here would lose it for good.
   */
  import { Check, Copy, Download } from '@lucide/svelte';
  import { accountSaveSecretFile } from '$lib/api/account';
  import type { SecretFile } from '$lib/api/account';
  import { isTauri } from '$lib/api/core';
  import { Button } from '$lib/components/ui/button';
  import { isMobile } from '$lib/platform';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    title: string;
    explanation: string;
    /** One line for a recovery key, one per code for backup codes. */
    lines: string[];
    /** What to write when the user asks for a file. Without it there is no
     *  such button. */
    file?: SecretFile;
    onDone: () => void;
  }

  let { title, explanation, lines, file, onDone }: Props = $props();

  let stored = $state(false);
  let copied = $state(false);
  let saved = $state(false);
  let saveFailed = $state(false);

  // The file is written by the desktop app, through a save dialog. A phone
  // hands back a place the app cannot write a path to, and a browser has no
  // app at all.
  const canSave = $derived(file !== undefined && isTauri() && !isMobile());

  async function save() {
    if (!file) return;
    saveFailed = false;
    try {
      // False is the user closing the dialog, which is not worth a word.
      if (await accountSaveSecretFile(file)) saved = true;
    } catch (err) {
      console.warn('[account] saving the file failed', err);
      saveFailed = true;
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      copied = true;
    } catch (err) {
      // No clipboard access. The text is selectable, so nothing is lost.
      console.warn('[account] copy failed', err);
    }
  }
</script>

<div
  class="grid gap-2 rounded-md border border-primary/40 bg-primary/5 p-3"
  data-testid="secret-reveal"
>
  <div class="text-sm font-medium">{title}</div>
  <p class="text-xs text-muted-foreground">{explanation}</p>
  <div
    class="select-all break-all rounded-md border border-border bg-background p-2 font-mono text-xs leading-relaxed"
    data-testid="secret-reveal-text"
  >
    {#each lines as line (line)}
      <div>{line}</div>
    {/each}
  </div>
  <div class="flex flex-wrap items-center gap-3">
    <Button type="button" size="sm" variant="secondary" onclick={copy}>
      <span class="inline-flex items-center">
        {#if copied}
          <Check class="mr-1.5 size-3.5" />
        {:else}
          <Copy class="mr-1.5 size-3.5" />
        {/if}
        {tUi(copied ? 'account.reveal.copied' : 'account.reveal.copy')}
      </span>
    </Button>
    {#if canSave}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onclick={save}
        data-testid="secret-reveal-save"
      >
        <span class="inline-flex items-center">
          {#if saved}
            <Check class="mr-1.5 size-3.5" />
          {:else}
            <Download class="mr-1.5 size-3.5" />
          {/if}
          {tUi(saved ? 'account.reveal.saved' : 'account.reveal.save')}
        </span>
      </Button>
    {/if}
    <label class="flex items-center gap-2 text-xs">
      <input
        type="checkbox"
        bind:checked={stored}
        data-testid="secret-reveal-stored"
      />
      {tUi('account.reveal.stored')}
    </label>
  </div>
  {#if saveFailed}
    <p class="text-xs text-destructive" data-testid="secret-reveal-save-failed">
      {tUi('account.reveal.saveFailed')}
    </p>
  {/if}
  <div>
    <Button
      type="button"
      size="sm"
      disabled={!stored}
      onclick={onDone}
      data-testid="secret-reveal-done"
    >
      {tUi('account.reveal.done')}
    </Button>
  </div>
</div>
