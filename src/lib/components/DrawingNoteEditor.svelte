<script lang="ts">
  /**
   * Editor for `note_kind === 'ink'` notes.
   *
   * Android: toggles the native SurfaceView injected by
   * `io.crates.drawing.Drawing`. The actual pixels come from
   * `src-tauri/src/drawing/render.rs` on its own thread; this
   * component renders nothing visible — the SurfaceView sits on
   * top with `setZOrderOnTop(true)`, inset by topMargin so the
   * Svelte mobile header stays reachable above it.
   *
   * Persistence (C2): on mount we `loadNote(noteId)` from SQLite,
   * pass the `yrs_state` bytes to Rust as the initial CRDT state.
   * On destroy we ask Rust for the current state via
   * `drawingGetState()` and persist via the existing `saveNote`
   * — same Etebase-sync path the markdown / freeform notes use.
   *
   * Desktop: the native layer isn't implemented yet (Phase 2 of
   * the roadmap). Show a placeholder.
   */
  import { onDestroy, onMount } from 'svelte';
  import { PenTool } from 'lucide-svelte';
  import {
    drawingGetState,
    drawingHide,
    drawingShow,
    loadNote,
    saveNote
  } from '$lib/api';
  import { isAndroid } from '$lib/platform';
  import { navigateBack } from '$lib/mobile/state.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    noteId: string;
  }
  let { noteId }: Props = $props();

  let mountedAndroid = false;
  let backCleanup: (() => void) | null = null;

  onMount(async () => {
    if (!isAndroid()) return;
    // The native egui toolbar's Back button bounces through Rust →
    // Kotlin → webView.evaluateJavascript, which dispatches this
    // CustomEvent on the WebView's window. We respond by popping
    // the browser-history entry openNote pushed; the popstate
    // listener in mobile/state.svelte then runs
    // setMobileScreen('home') which unmounts this component, whose
    // onDestroy below saves + detaches. Routing through
    // navigateBack (rather than setMobileScreen directly) keeps the
    // history stack in sync.
    const onBack = () => navigateBack();
    window.addEventListener('drawing-back', onBack);
    backCleanup = () => window.removeEventListener('drawing-back', onBack);

    // Load the persisted CRDT state from SQLite before bringing the
    // surface up so the first rendered frame already shows the
    // existing strokes. A brand-new note has yrs_state === [] and
    // the Rust side treats that as a fresh StrokesDoc.
    let initialState: number[] = [];
    try {
      const note = await loadNote(noteId);
      initialState = note.yrs_state ?? [];
    } catch (err) {
      // If we can't load the note, log it but still bring the
      // surface up with empty state — better to let the user draw
      // (and lose nothing) than fail the whole open.
      console.warn('[ink] loadNote failed; opening with empty state', err);
    }
    // noteId selects which per-note CanvasDocument the render
    // thread pulls strokes from; the active-note swap happens
    // before the SurfaceView comes up so the first frame already
    // shows the right note's content (rather than briefly the
    // previous one).
    void drawingShow(noteId, initialState);
    mountedAndroid = true;
  });

  onDestroy(() => {
    backCleanup?.();
    backCleanup = null;
    if (!mountedAndroid) return;
    // Save first, then hide. Both are async at the Tauri-IPC
    // level; we deliberately don't await on the way out of
    // onDestroy (Svelte's lifecycle can't), so the save and hide
    // race — but they touch independent code paths (save is
    // SQLite-write via the render thread's GetState ack, hide is
    // a Kotlin removeView). Worst case if onDestroy is racy: the
    // save finishes after the surface is gone, which is fine.
    //
    // Capture noteId so the closure doesn't see a later-mounted
    // editor's id if the component is being torn down to mount a
    // different note.
    const idAtClose = noteId;
    void (async () => {
      try {
        const yrsState = await drawingGetState();
        if (yrsState.length > 0) {
          await saveNote({ id: idAtClose, yrs_state: yrsState });
        }
      } catch (err) {
        console.warn('[ink] save on close failed', err);
      }
    })();
    void drawingHide();
  });
</script>

{#if isAndroid()}
  <!-- Empty viewport. The native SurfaceView paints above the WebView
       via setZOrderOnTop(true); this div exists only so the editor
       layout has a host element and so the WebView has a measurable
       region for hit-testing back into the Svelte shell if we ever
       drop zOrderOnTop. -->
  <div class="h-full w-full"></div>
{:else}
  <div
    class="flex h-full w-full items-center justify-center p-6 text-center"
  >
    <div
      class="flex max-w-md flex-col items-center gap-3 rounded-lg border border-border bg-card p-6"
    >
      <PenTool class="size-8 text-muted-foreground" aria-hidden="true" />
      <p class="text-sm font-medium text-foreground">
        {tUi('editor.ink.desktopPlaceholderTitle')}
      </p>
      <p class="text-sm text-muted-foreground">
        {tUi('editor.ink.desktopPlaceholderMessage')}
      </p>
    </div>
  </div>
{/if}
