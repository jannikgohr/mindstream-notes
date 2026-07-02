<script lang="ts">
  /**
   * Standalone Tauri window that renders one note. In custom-titlebar mode
   * this component owns the draggable title bar; in native-decoration mode
   * the OS owns window controls and this renders only the pop-in affordance.
   *
   * Dispatch mirrors DesktopLayout.openNote: load the note, then route
   * to the editor matching its `note_kind`. Unknown kinds (e.g. from a
   * newer-app-version peer) render `UnknownNoteKindError` instead of
   * silently mounting `NoteEditor` and corrupting the body on save.
   */
  import { onMount } from 'svelte';
  import { ArrowLeftToLine } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import NoteKindRenderer from '$lib/components/NoteKindRenderer.svelte';
  import WindowControls from '$lib/components/WindowControls.svelte';
  import { loadNote, openNoteWindow, type NoteKind } from '$lib/api';
  import { tree } from '$lib/stores/tree.svelte';
  import { subscribeOpenNoteRequest } from '$lib/stores/open-note-intent.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    initWindowChrome,
    windowChrome
  } from '$lib/window/decorations.svelte';

  interface Props {
    noteId: string;
  }
  let { noteId }: Props = $props();

  let title = $state('Note');
  let exists = $state<boolean | null>(null);
  // Captured at load time so we don't re-derive on every paint and so
  // a later sync-pulled mutation can't swap the editor out from under
  // the user (the editor itself merges incoming yrs_state — its kind
  // is immutable for the panel's lifetime).
  let noteKind = $state<NoteKind | string | null>(null);

  onMount(async () => {
    initWindowChrome();
    try {
      const note = await loadNote(noteId);
      title = note.title;
      noteKind = note.note_kind;
      exists = true;
    } catch (err) {
      console.warn('[popout] note not found', noteId, err);
      exists = false;
    }
  });

  // A wikilink click inside this popout dispatches through the
  // open-note bus. This window only renders one note, so we can't
  // "switch" — same-note requests are a no-op, other-note requests
  // spawn another popout window. Subscribers in different windows
  // don't see each other (each Tauri window is its own JS context).
  onMount(() => {
    return subscribeOpenNoteRequest((id) => {
      if (id === noteId) return;
      const target = tree.notesById[id];
      void openNoteWindow(id, target?.title ?? 'Note', null, null);
    });
  });

  async function closeCurrentWindow() {
    if (typeof window === 'undefined') return;
    if (!('__TAURI_INTERNALS__' in window)) {
      window.close();
      return;
    }
    try {
      const mod = await import('@tauri-apps/api/window');
      await mod.getCurrentWindow().close();
    } catch (err) {
      console.warn('[popout] close failed', err);
    }
  }
</script>

<div class="flex h-full w-full flex-col bg-background text-foreground">
  {#if windowChrome.customDecorations}
    <!-- Frameless title bar. data-tauri-drag-region on the wrapping header
         lets the user drag the window from any non-button area. -->
    <header
      data-tauri-drag-region
      class="flex h-9 shrink-0 select-none items-center gap-1 border-b border-border bg-card px-2"
    >
      <span
        data-tauri-drag-region
        class="ml-2 truncate text-xs font-medium text-muted-foreground"
      >
        {title}
      </span>
      <div data-tauri-drag-region class="flex-1"></div>
      <WindowControls mode="popout" />
    </header>
  {:else}
    <header
      class="flex h-9 shrink-0 select-none items-center gap-1 border-b border-border bg-card px-2"
    >
      <span class="ml-2 truncate text-xs font-medium text-muted-foreground">
        {title}
      </span>
      <div class="flex-1"></div>
      <Button
        variant="ghost"
        size="icon"
        onclick={closeCurrentWindow}
        title={tUi('editor.popin')}
        aria-label={tUi('editor.popin')}
      >
        <ArrowLeftToLine class="size-4" />
      </Button>
    </header>
  {/if}

  <main class="min-h-0 flex-1 overflow-hidden fullscreen-note">
    {#if exists === null}
      <p class="p-4 text-sm text-muted-foreground">Loading…</p>
    {:else if !exists}
      <div
        class="flex h-full items-center justify-center p-6 text-sm text-muted-foreground"
      >
        Note <code class="mx-1 rounded bg-muted px-1.5 py-0.5">{noteId}</code>
        couldn't be found in the database.
      </div>
    {:else}
      <NoteKindRenderer {noteId} {noteKind} />
    {/if}
  </main>
</div>
