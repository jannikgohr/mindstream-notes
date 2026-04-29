<script lang="ts">
  /**
   * Standalone Tauri window that just renders one note. The note may not
   * be in the tree cache yet (the new window has its own JS heap), so we
   * fetch a quick summary on mount to show the title; the editor itself
   * loads the body lazily through the same code path as the main window.
   */
  import { onMount } from 'svelte';
  import NoteEditor from './NoteEditor.svelte';
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
  <header
    class="flex h-9 shrink-0 items-center border-b border-border bg-card px-3 text-xs font-medium text-muted-foreground"
  >
    {title}
  </header>

  <main class="min-h-0 flex-1 overflow-hidden">
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
