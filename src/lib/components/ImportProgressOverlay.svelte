<script lang="ts">
  /**
   * Covers the window while a notes import runs, so the app waiting on it
   * looks deliberate rather than stuck. The import holds the vault's write
   * lock until it ends, and every window waits for it, not only the one that
   * started it. That one shows the same progress in the import dialog, so the
   * overlay stays away there (`importActivity.shownByDialog`).
   */
  import { tick } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { cancelImport } from '$lib/api/notes-import';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { importActivity } from '$lib/storage/import-activity.svelte';

  const shown = $derived(
    importActivity.running && !importActivity.shownByDialog
  );
  const percent = $derived(
    importActivity.total > 0
      ? Math.min(
          100,
          Math.round((importActivity.done / importActivity.total) * 100)
        )
      : null
  );
  let stopping = $state(false);
  let stopButton = $state<HTMLButtonElement | null>(null);

  $effect(() => {
    if (!shown) {
      stopping = false;
      return;
    }
    void tick().then(() => stopButton?.focus());
  });

  async function stop() {
    stopping = true;
    try {
      await cancelImport();
    } catch (error) {
      console.error('[import] stop failed', error);
      stopping = false;
    }
  }

  // Stop is the one control here: keep focus on it, and keep Escape from
  // reaching whatever lies underneath.
  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Tab' || event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      stopButton?.focus();
    }
  }
</script>

{#if shown}
  <div
    class="fixed inset-0 z-[450] flex items-center justify-center bg-scrim p-4 backdrop-blur-sm"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="import-progress-title"
    aria-describedby="import-progress-status"
    tabindex="-1"
    onkeydown={onKeydown}
  >
    <div
      class="w-[min(440px,94vw)] rounded-lg border border-border bg-card p-5 text-card-foreground shadow-xl"
    >
      <h2 id="import-progress-title" class="text-base font-semibold">
        {tUi('data.importNotes.running.title')}
      </h2>
      <p id="import-progress-status" class="mt-1 text-xs text-muted-foreground">
        {#if importActivity.total > 0}
          {tUi('data.importNotes.running.counted')
            .replace('{done}', String(importActivity.done))
            .replace('{total}', String(importActivity.total))}
        {:else}
          {tUi('data.importNotes.running.scanning')}
        {/if}
      </p>
      <div
        class="mt-4 h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-labelledby="import-progress-title"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <div
          class="h-full bg-primary transition-[width] duration-200"
          style={`width: ${percent ?? 5}%`}
        ></div>
      </div>
      <p class="mt-3 text-xs text-muted-foreground">
        {tUi('data.importNotes.running.waits')}
      </p>
      <div class="mt-5 flex justify-end">
        <Button
          bind:ref={stopButton}
          variant="ghost"
          disabled={stopping}
          onclick={stop}
        >
          {tUi('data.importNotes.button.stop')}
        </Button>
      </div>
    </div>
  </div>
{/if}
