<script lang="ts">
  /**
   * Standalone Tauri window that renders one note. The popout's window is
   * spawned with decorations: false (matching the main window), so this
   * component owns the title bar — drag region in the centre, custom min/
   * max/close trio on the right.
   */
  import { onMount } from 'svelte';
  import NoteEditor from './NoteEditor.svelte';
  import WindowControls from './WindowControls.svelte';
  import { loadNote } from '$lib/api';

  interface Props {
    noteId: string;
  }
  let { noteId }: Props = $props();

  let title = $state('Note');
  let exists = $state<boolean | null>(null);

  onMount(async () => {
    try {
      const note = await loadNote(noteId);
      title = note.title;
      exists = true;
    } catch (err) {
      console.warn('[popout] note not found', noteId, err);
      exists = false;
    }
  });
</script>

<div class="flex h-full w-full flex-col bg-background text-foreground">
  <!-- Frameless title bar. data-tauri-drag-region on the wrapping header
       lets the user drag the window from any non-button area. -->
  <header
    data-tauri-drag-region
    class="flex h-9 shrink-0 select-none items-center gap-1 border-b border-border bg-card px-2"
  >
    <span data-tauri-drag-region class="ml-2 truncate text-xs font-medium text-muted-foreground">
      {title}
    </span>
    <div data-tauri-drag-region class="flex-1"></div>
    <WindowControls />
  </header>

  <main class="min-h-0 flex-1 overflow-hidden fullscreen-note">
    {#if exists === null}
      <p class="p-4 text-sm text-muted-foreground">Loading…</p>
    {:else if exists}
      <NoteEditor {noteId} />
    {:else}
      <div class="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Note <code class="mx-1 rounded bg-muted px-1.5 py-0.5">{noteId}</code>
        couldn't be found in the database.
      </div>
    {/if}
  </main>
</div>
