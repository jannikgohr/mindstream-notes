<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Crepe } from '@milkdown/crepe';
  import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
  import { saveNote } from '$lib/tauri';
  import { notes, updateNoteBody } from '$lib/state.svelte';

  interface Props {
    noteId: string;
  }
  let { noteId }: Props = $props();

  let host: HTMLDivElement | null = $state(null);
  let crepe: Crepe | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  onMount(async () => {
    if (!host) return;

    // Pull the initial value from the in-memory store. Future enhancement:
    // call `loadNote(noteId)` here if the body isn't cached yet.
    const initial = notes.byId[noteId]?.body ?? '';

    crepe = new Crepe({
      root: host,
      defaultValue: initial
    });

    // Crepe forwards Milkdown's editor instance through `editor`. Wire up the
    // listener plugin so we can react to markdown changes.
    crepe.editor.use(listener).config((ctx) => {
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        handleChange(markdown);
      });
    });

    await crepe.create();
  });

  onDestroy(() => {
    if (saveTimer) clearTimeout(saveTimer);
    crepe?.destroy();
    crepe = null;
  });

  function handleChange(markdown: string) {
    updateNoteBody(noteId, markdown);

    // Debounced save — 500ms after the user stops typing, persist to Rust.
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const note = notes.byId[noteId];
      if (!note) return;
      saveNote({ id: note.id, title: note.title, body: markdown }).catch(
        (err) => console.error('[NoteEditor] saveNote failed', err)
      );
    }, 500);
  }
</script>

<div class="h-full w-full overflow-y-auto">
  <div bind:this={host} class="mx-auto max-w-3xl"></div>
</div>
