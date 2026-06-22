<script lang="ts">
  /**
   * Standalone Tauri window that renders one note. The popout's window is
   * spawned with decorations: false (matching the main window), so this
   * component owns the title bar — drag region in the centre, custom min/
   * max/close trio on the right.
   *
   * Dispatch mirrors DesktopLayout.openNote: load the note, then route
   * to the editor matching its `note_kind`. Unknown kinds (e.g. from a
   * newer-app-version peer) render `UnknownNoteKindError` instead of
   * silently mounting `NoteEditor` and corrupting the body on save.
   */
  import { onMount } from 'svelte';
  import NoteKindRenderer from '$lib/components/NoteKindRenderer.svelte';
  import WindowControls from '$lib/components/WindowControls.svelte';
  import { loadNote, openNoteWindow, type NoteKind } from '$lib/api';
  import { tree } from '$lib/stores/tree.svelte';
  import { subscribeOpenNoteRequest } from '$lib/stores/open-note-intent.svelte';

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
</script>

<div class="flex h-full w-full flex-col bg-background text-foreground">
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
    <WindowControls />
  </header>

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
