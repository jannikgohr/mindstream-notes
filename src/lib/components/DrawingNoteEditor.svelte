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
   * Auto-save: the Rust render thread emits a `drawing:dirty`
   * event whenever a stroke ends or the canvas is cleared, and the
   * `scheduleSave` debounce below picks that up — same shape as
   * FreeformNoteEditor's yDoc-update-driven save, just with the
   * change signal coming over the Tauri event bus instead of a
   * local Y.Doc subscription (the StrokesDoc lives on the render
   * thread, not in JS). The onDestroy path additionally flushes
   * any pending debounce so a navigation-away doesn't drop the
   * last 800 ms of work.
   *
   * Desktop: the native layer isn't implemented yet (Phase 2 of
   * the roadmap). Show a placeholder.
   */
  import { onDestroy, onMount } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { PenTool } from 'lucide-svelte';
  import {
    drawingGetState,
    drawingHide,
    drawingShow,
    saveNote,
    TRASH_ID
  } from '$lib/api';
  import { isAndroid } from '$lib/platform';
  import { navigateBack } from '$lib/mobile/state.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { tree } from '$lib/stores/tree.svelte';
  import {
    clearNoteStatus,
    setNoteStatus,
    type SavingState
  } from '$lib/stores/note-status.svelte';

  interface Props {
    noteId: string;
  }
  let { noteId }: Props = $props();

  /** Debounce window before flushing accumulated stroke changes to
   *  SQLite. 800 ms matches FreeformNoteEditor and NoteEditor so
   *  the "feels saved" UX timing is consistent across editor kinds. */
  const SAVE_DEBOUNCE_MS = 800;

  let mountedAndroid = false;
  let backCleanup: (() => void) | null = null;
  let unsubDirty: UnlistenFn | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let savingState = $state<SavingState>('idle');

  // ---- Trash detection (same shape as FreeformNoteEditor) ----
  //
  // A note is trashed if it's directly under the trash collection,
  // any of its ancestors is, or its row says so. Used to short-
  // circuit auto-save — a trashed note shouldn't keep writing back
  // to SQLite while the user looks at it read-only.

  function ancestorIsTrash(parentId: string | null): boolean {
    let current = parentId;
    const seen = new Set<string>();
    while (current) {
      if (current === TRASH_ID) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      current = tree.collectionsById[current]?.parent_collection_id ?? null;
    }
    return false;
  }

  const isTrashed = $derived.by(() => {
    if (!tree.ready) return false;
    const n = tree.notesById[noteId];
    if (!n) return true;
    if (n.trashed === true) return true;
    return ancestorIsTrash(n.parent_collection_id);
  });

  // Mirror our reactive status into the global per-note store so
  // the dockview right-header (NoteStatusIcons.svelte) renders the
  // saving / trash icons next to the popout button. Same plumbing
  // NoteEditor + FreeformNoteEditor use; ink notes have no collab
  // (C5 pending), so collabConfigured / collabOnline stay false.
  $effect(() => {
    setNoteStatus(noteId, {
      collabConfigured: false,
      collabOnline: false,
      savingState,
      isTrashed
    });
  });

  onMount(async () => {
    if (!isAndroid()) return;
    // Open-latency timing markers — these go into the WebView's
    // console, which Android relays into logcat under the
    // "chromium" / "console" tags. Combined with the Rust-side
    // `[drawing.perf]` logs they give a full picture: JS-perceived
    // loadNote + drawingShow durations vs. wgpu init vs. surface
    // attach. Strip these when the perf investigation is done.
    const tMountStart = performance.now();
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

    // Subscribe to the render thread's "stroke document changed,
    // save me soon" event. Filter by noteId in the payload because
    // desktop dockview can have multiple ink notes open in separate
    // tabs (when E1 lands); each editor instance only schedules
    // saves for its own note.
    unsubDirty = await listen<string>('drawing:dirty', (event) => {
      if (event.payload !== noteId) return;
      scheduleSave();
    });

    // Bring the native surface up. The Rust side reads the
    // persisted yrs_state from SQLite itself (see drawing_show)
    // so we don't ship the (potentially MB-class) blob through
    // Tauri's JSON-encoded IPC. noteId selects which per-note
    // CanvasDocument the render thread pulls strokes from; the
    // active-note swap happens before the SurfaceView comes up so
    // the first frame already shows the right note's content
    // (rather than briefly the previous one).
    const tShowStart = performance.now();
    void drawingShow(noteId);
    const tShowEnd = performance.now();
    mountedAndroid = true;
    console.log(
      `[ink-open] drawingShow_ipc=${(tShowEnd - tShowStart).toFixed(1)}ms ` +
        `total_to_show=${(tShowEnd - tMountStart).toFixed(1)}ms`
    );
  });

  onDestroy(() => {
    backCleanup?.();
    backCleanup = null;
    if (saveTimer) {
      // Drop the pending debounce — the close-save below runs
      // synchronously after this, and flushing the current state
      // through saveNote is what would happen anyway.
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    unsubDirty?.();
    unsubDirty = null;
    // Clear the dockview status row so closing the panel removes
    // its icons. Must come after the close-save schedules, before
    // the component is fully torn down.
    clearNoteStatus(noteId);
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

  // ---- Auto-save (debounced) ----
  //
  // Triggered by the render thread's `drawing:dirty` event (fired
  // at stroke-end, eraser-clear, and toolbar-clear). Trashed notes
  // skip saving — the on-disk snapshot stays whatever it was when
  // they went to trash.

  function scheduleSave() {
    if (isTrashed) return;
    savingState = 'pending';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        savingState = 'saving';
        const yrsState = await drawingGetState();
        // Empty state shouldn't happen mid-session (we got a
        // dirty event, which means strokes changed) but defensive:
        // if it does, skip the save rather than wipe whatever's
        // on disk with empty bytes.
        if (yrsState.length === 0) {
          savingState = 'saved';
          return;
        }
        await saveNote({ id: noteId, yrs_state: yrsState });
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
        console.error('[ink] auto-save failed', err);
      }
    }, SAVE_DEBOUNCE_MS);
  }
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
