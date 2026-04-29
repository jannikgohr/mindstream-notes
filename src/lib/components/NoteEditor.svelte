<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Crepe } from '@milkdown/crepe';
  import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
  import { loadNote, saveNote as apiSaveNote } from '$lib/api';
  import { tree } from '$lib/stores/tree.svelte';

  interface Props {
    noteId: string;
  }
  let { noteId }: Props = $props();

  /**
   * Debounce the auto-save: wait this long after the last keystroke before
   * hitting Rust. The user said "save after inactivity" — 800ms feels
   * unhurried but doesn't risk losing typing in a crash.
   */
  const SAVE_DEBOUNCE_MS = 800;

  let host: HTMLDivElement | null = $state(null);
  let crepe: Crepe | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let loading = $state(true);
  let savingState = $state<'idle' | 'pending' | 'saving' | 'saved' | 'error'>(
    'idle'
  );
  let loadError = $state<string | null>(null);

  onMount(async () => {
    if (!host) return;
    try {
      const note = await loadNote(noteId);
      if (!host) return; // unmounted while awaiting
      crepe = new Crepe({
        root: host,
        defaultValue: note.body
      });
      crepe.editor.use(listener).config((ctx) => {
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          handleChange(markdown);
        });
      });
      await crepe.create();
      loading = false;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      loading = false;
      console.error('[NoteEditor] load failed', err);
    }
  });

  onDestroy(() => {
    if (saveTimer) clearTimeout(saveTimer);
    crepe?.destroy();
    crepe = null;
  });

  function handleChange(markdown: string) {
    savingState = 'pending';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        savingState = 'saving';
        await apiSaveNote({ id: noteId, body: markdown });
        // Mirror the new modified timestamp in the local cache so the
        // metadata panel reflects the save without a tree refetch.
        const existing = tree.notesById[noteId];
        if (existing) {
          tree.notesById[noteId] = {
            ...existing,
            modified: new Date().toISOString()
          };
        }
        savingState = 'saved';
      } catch (err) {
        savingState = 'error';
        console.error('[NoteEditor] save failed', err);
      }
    }, SAVE_DEBOUNCE_MS);
  }

  const statusLabel = $derived.by(() => {
    switch (savingState) {
      case 'pending':
        return 'Editing…';
      case 'saving':
        return 'Saving…';
      case 'saved':
        return 'Saved';
      case 'error':
        return 'Save failed';
      default:
        return '';
    }
  });
</script>

<div class="flex h-full w-full flex-col">
  <div
    class="pointer-events-none flex h-5 shrink-0 items-center justify-end px-3 text-[10px] uppercase tracking-wider text-muted-foreground"
    aria-live="polite"
  >
    {statusLabel}
  </div>
  <div class="themed-scrollbar relative h-full w-full overflow-y-auto">
    {#if loading}
      <p class="px-6 py-4 text-sm text-muted-foreground">Loading note…</p>
    {:else if loadError}
      <p class="px-6 py-4 text-sm text-destructive">
        Couldn't load note: {loadError}
      </p>
    {/if}
    <div bind:this={host} class="mx-auto max-w-3xl"></div>
  </div>
</div>
