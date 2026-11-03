<script lang="ts">
  import { browserTestVaultId } from './testing';
  import { tUi, tUiFormat } from '$lib/settings/i18n.svelte';

  const id = browserTestVaultId();
  let busy = $state(false);
  let error = $state(false);
  async function reset() {
    busy = true;
    error = false;
    try {
      const { prepareBrowserTestReset } = await import('./vault');
      await prepareBrowserTestReset();
      window.location.reload();
    } catch (cause) {
      console.error('[browser] test reset failed', cause);
      error = true;
      busy = false;
    }
  }
</script>

{#if id}
  <aside
    aria-label={tUi('browser.testing.label')}
    class="fixed bottom-4 left-1/2 z-500 flex max-w-[95vw] -translate-x-1/2 flex-wrap items-center gap-2 rounded-lg border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg"
  >
    <span>{tUiFormat('browser.testing.vault', { id })}</span>
    <button
      type="button"
      class="rounded border border-border px-2 py-1 hover:bg-accent disabled:opacity-50"
      disabled={busy}
      onclick={reset}
    >
      {tUi(busy ? 'browser.testing.resetting' : 'browser.testing.reset')}
    </button>
    {#if error}<p role="alert">{tUi('browser.testing.failed')}</p>{/if}
  </aside>
{/if}
