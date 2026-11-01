<script lang="ts">
  import { recoveryStatus } from './recovery-status.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  let dismissed = $state(false);

  function download() {
    const blob = new Blob([JSON.stringify(recoveryStatus.copies, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'note-recovery.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
</script>

{#if !dismissed && (recoveryStatus.unavailable || recoveryStatus.copies.length)}
  <div
    role="alert"
    class="fixed bottom-4 left-4 z-500 flex max-w-md flex-wrap items-center gap-2 rounded-lg border border-border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
  >
    <p>
      {tUi(
        recoveryStatus.copies.length
          ? 'browser.recovery.retained'
          : 'browser.recovery.unavailable'
      )}
    </p>
    {#if recoveryStatus.copies.length}
      <button
        class="rounded border border-border px-2 py-1 hover:bg-accent"
        onclick={download}
      >
        {tUi('browser.recovery.download')}
      </button>
    {/if}
    <button
      class="rounded border border-border px-2 py-1 hover:bg-accent"
      onclick={() => (dismissed = true)}
    >
      {tUi('close')}
    </button>
  </div>
{/if}
