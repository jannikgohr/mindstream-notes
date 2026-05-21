<script lang="ts">
  /**
   * Mobile-only Live / Saved indicator strip that sits above the editor.
   *
   * Desktop pushes the same state into the per-note status store and
   * the dockview right-header (`NoteStatusIcons.svelte`) renders the
   * icon equivalent next to the popout button — mobile has no such
   * header, so we draw it inline. Hidden on trashed notes because the
   * TrashBanner already conveys read-only.
   */
  import { Wifi, WifiOff } from 'lucide-svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  type SavingState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

  interface Props {
    collabConfigured: boolean;
    collabOnline: boolean;
    savingState: SavingState;
    isTrashed: boolean;
  }
  let { collabConfigured, collabOnline, savingState, isTrashed }: Props =
    $props();

  const statusLabel = $derived.by(() => {
    if (isTrashed) return tUi('editor.status.short.readonly');
    switch (savingState) {
      case 'pending':
        return tUi('editor.status.editing');
      case 'saving':
        return tUi('editor.status.saving');
      case 'saved':
        return tUi('editor.status.saved');
      case 'error':
        return tUi('editor.status.error');
      default:
        return '';
    }
  });
</script>

<div
  class="flex h-5 shrink-0 items-center justify-end gap-2 px-3 text-[10px] uppercase tracking-wider text-muted-foreground"
  aria-live="polite"
>
  {#if collabConfigured}
    {#if collabOnline}
      <span
        class="flex items-center gap-1 text-emerald-600 dark:text-emerald-400"
        title={tUi('editor.status.live')}
      >
        <Wifi class="size-3" aria-hidden="true" />
        {tUi('editor.status.short.live')}
      </span>
    {:else}
      <span
        class="flex items-center gap-1"
        title={tUi('editor.status.offline')}
      >
        <WifiOff class="size-3" aria-hidden="true" />
        {tUi('editor.status.short.offline')}
      </span>
    {/if}
  {/if}
  <span>{statusLabel}</span>
</div>
