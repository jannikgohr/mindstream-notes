<script lang="ts">
  /**
   * Icon-only status chips rendered in the dockview right-header,
   * sitting just left of the popout button. Shows the active note's
   * live-collab connection + save state. Tooltips are translated via
   * `tUi()`.
   *
   * Mounted into dockview's plain-DOM `PopoutHeaderAction` element via
   * Svelte 5's `mount()` — see dockview-popout-action.ts.
   *
   * Read-only priority: when the note is trashed, the save/collab
   * stack collapses to a single Trash2 chip so we don't claim a
   * "Saving…" indicator for a note the user can't actually edit.
   */
  import {
    AlertCircle,
    Check,
    Loader2,
    Pencil,
    Trash2,
    Wifi,
    WifiOff
  } from 'lucide-svelte';
  import { ui } from '$lib/state.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { getNoteStatus } from '$lib/stores/note-status.svelte';

  // Reading via the getter inside a $derived lets each field still
  // track reactively — getNoteStatus returns either the live entry or
  // the EMPTY constant, both of which are plain objects whose field
  // reads Svelte 5 tracks under the runes.
  const status = $derived(getNoteStatus(ui.activeNoteId));
</script>

<div class="flex items-center gap-1.5 px-1 text-muted-foreground">
  {#if status.collabConfigured}
    {#if status.collabOnline}
      <span
        class="inline-flex text-emerald-600 dark:text-emerald-400"
        title={tUi('editor.status.live')}
        aria-label={tUi('editor.status.live')}
      >
        <Wifi class="size-3.5" aria-hidden="true" />
      </span>
    {:else}
      <span
        class="inline-flex"
        title={tUi('editor.status.offline')}
        aria-label={tUi('editor.status.offline')}
      >
        <WifiOff class="size-3.5" aria-hidden="true" />
      </span>
    {/if}
  {/if}

  {#if status.isTrashed}
    <!-- Trashed wins over saving — a read-only note shouldn't
         flicker through Saving / Saved while a sync writes its
         metadata. -->
    <span
      class="inline-flex text-destructive"
      title={tUi('editor.status.readonly')}
      aria-label={tUi('editor.status.readonly')}
    >
      <Trash2 class="size-3.5" aria-hidden="true" />
    </span>
  {:else if status.savingState === 'saving'}
    <span
      class="inline-flex"
      title={tUi('editor.status.saving')}
      aria-label={tUi('editor.status.saving')}
    >
      <Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
    </span>
  {:else if status.savingState === 'pending'}
    <span
      class="inline-flex"
      title={tUi('editor.status.editing')}
      aria-label={tUi('editor.status.editing')}
    >
      <Pencil class="size-3.5" aria-hidden="true" />
    </span>
  {:else if status.savingState === 'saved'}
    <span
      class="inline-flex"
      title={tUi('editor.status.saved')}
      aria-label={tUi('editor.status.saved')}
    >
      <Check class="size-3.5" aria-hidden="true" />
    </span>
  {:else if status.savingState === 'error'}
    <span
      class="inline-flex text-destructive"
      title={tUi('editor.status.error')}
      aria-label={tUi('editor.status.error')}
    >
      <AlertCircle class="size-3.5" aria-hidden="true" />
    </span>
  {/if}
</div>
