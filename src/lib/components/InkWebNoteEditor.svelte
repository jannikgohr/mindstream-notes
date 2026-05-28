<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { loadNote, saveNote } from '$lib/api';
  import {
    setNoteStatus,
    type SavingState
  } from '$lib/stores/note-status.svelte';

  interface Props {
    noteId: string;
    ariaLabel: string;
  }

  let { noteId, ariaLabel }: Props = $props();

  const SAVE_DEBOUNCE_MS = 800;

  type WebInkHandleInstance = {
    start: (
      canvas: HTMLCanvasElement,
      initialState: Uint8Array,
      onChange: (bytes: Uint8Array) => void
    ) => Promise<void>;
    destroy?: () => void;
  };

  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let savingState = $state<SavingState>('idle');
  let disposed = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingState: number[] | null = null;
  let handle: WebInkHandleInstance | null = null;

  $effect(() => {
    setNoteStatus(noteId, {
      collabConfigured: false,
      collabOnline: false,
      savingState,
      isTrashed: false
    });
  });

  function clearSaveTimer() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  async function flushPendingState() {
    const state = pendingState;
    if (!state || disposed) return;
    pendingState = null;
    savingState = 'saving';
    try {
      await saveNote({ id: noteId, yrs_state: state });
      savingState = 'saved';
    } catch (err) {
      pendingState = state;
      savingState = 'error';
      console.warn('[ink-web] failed to save note', err);
    }
  }

  function scheduleSave(bytes: Uint8Array) {
    pendingState = Array.from(bytes);
    savingState = 'pending';
    clearSaveTimer();
    saveTimer = setTimeout(() => void flushPendingState(), SAVE_DEBOUNCE_MS);
  }

  onMount(async () => {
    if (!canvasEl) return;
    const note = await loadNote(noteId);
    if (disposed || !canvasEl) return;

    const mod = await import('$lib/ink-web/pkg/ink_egui_web.js');
    if (disposed || !canvasEl) return;

    const init = mod.default as unknown as () => Promise<unknown>;
    await init();

    const WebInkHandle = mod.WebInkHandle as new () => WebInkHandleInstance;

    handle = new WebInkHandle();
    await handle.start(
      canvasEl,
      new Uint8Array(note.yrs_state),
      (bytes: Uint8Array) => scheduleSave(bytes)
    );
  });

  onDestroy(() => {
    clearSaveTimer();
    void flushPendingState();
    disposed = true;
    handle?.destroy?.();
    handle = null;
  });
</script>

<canvas
  bind:this={canvasEl}
  class="block h-full w-full bg-muted/20"
  aria-label={ariaLabel}
></canvas>
