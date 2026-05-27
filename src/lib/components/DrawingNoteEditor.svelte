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
   * Persistence (P4): the Rust-side `save_worker` thread owns the
   * full debounce + SQLite write flow. The render thread fires a
   * `notify_dirty(note_id)` after every mutating gesture; the
   * worker debounces, fetches the encoded yrs bytes via an
   * in-process render-thread channel (never IPC), and writes
   * directly to SQLite via `notes::save_yrs_state`. The yrs blob
   * never crosses the JS↔Rust boundary anymore — what used to be
   * two MB-class IPC round-trips per save is now zero.
   *
   * This editor only listens for `drawing:save_status` events from
   * the worker (`editing` / `saving` / `saved` / `error`) and
   * mirrors them into the global note-status store so the dockview
   * saving-icon reflects live state. It also pushes the user's
   * debounce setting to the worker via
   * `drawing_set_save_debounce` and asks the worker to flush any
   * pending save on note close (so a "drew, immediately navigated
   * away" gesture doesn't strand the change for the rest of the
   * debounce window).
   *
   * Desktop: the native layer isn't implemented yet (Phase 2 of
   * the roadmap). Show a placeholder.
   */
  import { onDestroy, onMount } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { PenTool } from 'lucide-svelte';
  import {
    drawingHide,
    drawingShow,
    drawingSetSaveDebounce,
    drawingSetToolbarSettings,
    DRAWING_SAVE_STATUS_EVENT,
    DRAWING_TOOLBAR_SETTINGS_EVENT,
    type DrawingSaveStatusPayload,
    type DrawingToolbarSettingsPayload,
    TRASH_ID
  } from '$lib/api';
  import { isAndroid } from '$lib/platform';
  import { navigateBack } from '$lib/mobile/state.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    getSettingValue,
    hasSettingValue,
    setSettingValue
  } from '$lib/settings/store.svelte';
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

  /** Debounce window passed to the Rust save worker. 800 ms matches
   *  FreeformNoteEditor and NoteEditor so the "feels saved" UX
   *  timing is consistent across editor kinds. */
  const SAVE_DEBOUNCE_MS = 800;

  let mountedAndroid = false;
  let backCleanup: (() => void) | null = null;
  let unsubSaveStatus: UnlistenFn | null = null;
  let unsubToolbarSettings: UnlistenFn | null = null;
  let savingState = $state<SavingState>('idle');

  const INK_TOOL_SETTING = 'editor.ink.tool';
  const INK_COLOR_SETTING = 'editor.ink.color';
  const INK_WIDTH_SETTING = 'editor.ink.width';
  const INK_FINGER_SETTING = 'editor.ink.fingerDrawing';
  const INK_PAGE_THEME_SETTING = 'editor.ink.pageTheme';

  // ---- Trash detection (same shape as FreeformNoteEditor) ----
  //
  // A note is trashed if it's directly under the trash collection,
  // any of its ancestors is, or its row says so. Mirrored into the
  // note-status store so the dockview icon collapses to read-only.

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

  /** Translate the worker's snake_case status string into the
   *  `SavingState` the dockview saving-icon understands. */
  function mapWorkerStatus(s: DrawingSaveStatusPayload['status']): SavingState {
    switch (s) {
      case 'editing':
        return 'pending';
      case 'saving':
        return 'saving';
      case 'saved':
        return 'saved';
      case 'error':
        return 'error';
    }
  }

  function normalizeInkTool(value: unknown): 'pen' | 'eraser' {
    return value === 'eraser' ? 'eraser' : 'pen';
  }

  function normalizeInkPageTheme(value: unknown): 'light' | 'system' {
    return value === 'system' ? 'system' : 'light';
  }

  function normalizeInkWidth(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? Math.min(12, Math.max(0.5, n)) : 4;
  }

  function colorHexToArgb(value: unknown): number {
    const raw = typeof value === 'string' ? value : '#000000';
    const hex = raw.startsWith('#') ? raw.slice(1) : raw;
    const expanded =
      hex.length === 3
        ? hex
            .split('')
            .map((c) => c + c)
            .join('')
        : hex.slice(0, 6);
    const rgb = Number.parseInt(expanded.padEnd(6, '0'), 16);
    return (0xff000000 | (Number.isFinite(rgb) ? rgb : 0)) >>> 0;
  }

  function argbToColorHex(argb: number): string {
    return `#${(argb & 0x00ffffff).toString(16).padStart(6, '0')}`;
  }

  function currentToolbarSettings() {
    return {
      tool: normalizeInkTool(getSettingValue(INK_TOOL_SETTING)),
      colorArgb: colorHexToArgb(getSettingValue(INK_COLOR_SETTING)),
      width: normalizeInkWidth(getSettingValue(INK_WIDTH_SETTING)),
      fingerDrawingAllowed: hasSettingValue(INK_FINGER_SETTING)
        ? Boolean(getSettingValue(INK_FINGER_SETTING))
        : null,
      pageThemeMode: normalizeInkPageTheme(
        getSettingValue(INK_PAGE_THEME_SETTING)
      )
    };
  }

  async function saveToolbarSettings(
    payload: DrawingToolbarSettingsPayload
  ): Promise<void> {
    await Promise.all([
      setSettingValue(INK_TOOL_SETTING, normalizeInkTool(payload.tool)),
      setSettingValue(INK_COLOR_SETTING, argbToColorHex(payload.colorArgb)),
      setSettingValue(INK_WIDTH_SETTING, normalizeInkWidth(payload.width)),
      setSettingValue(INK_FINGER_SETTING, payload.fingerDrawingAllowed),
      setSettingValue(
        INK_PAGE_THEME_SETTING,
        normalizeInkPageTheme(payload.pageThemeMode)
      )
    ]);
  }

  onMount(async () => {
    if (!isAndroid()) return;
    // Open-latency timing marker — pairs with the Rust-side
    // `[drawing.perf]` logs for the full open story.
    const tMountStart = performance.now();
    // The native egui toolbar's Back button bounces through Rust →
    // Kotlin → webView.evaluateJavascript, which dispatches this
    // CustomEvent on the WebView's window. We respond by popping
    // the browser-history entry openNote pushed; the popstate
    // listener in mobile/state.svelte then runs
    // setMobileScreen('home') which unmounts this component, whose
    // onDestroy below detaches. Routing through navigateBack
    // (rather than setMobileScreen directly) keeps the history
    // stack in sync.
    const onBack = () => navigateBack();
    window.addEventListener('drawing-back', onBack);
    backCleanup = () => window.removeEventListener('drawing-back', onBack);

    // Subscribe to the save worker's status stream. Filter by
    // note id so a tab opening a different ink note (desktop
    // dockview, post-E1) doesn't cross-mix saving icons.
    unsubSaveStatus = await listen<DrawingSaveStatusPayload>(
      DRAWING_SAVE_STATUS_EVENT,
      (event) => {
        if (event.payload.note_id !== noteId) return;
        // Trashed notes still get worker events but we shouldn't
        // show "saving" — they're read-only by app convention.
        if (isTrashed) return;
        savingState = mapWorkerStatus(event.payload.status);
      }
    );

    unsubToolbarSettings = await listen<DrawingToolbarSettingsPayload>(
      DRAWING_TOOLBAR_SETTINGS_EVENT,
      (event) => {
        void saveToolbarSettings(event.payload).catch((err) => {
          console.warn('[ink-toolbar] failed to save toolbar settings', err);
        });
      }
    );

    // Make sure the worker's debounce matches what this editor
    // expects. Cheap fire-and-forget; worker no-ops if the value
    // hasn't changed since the last push.
    void drawingSetSaveDebounce(SAVE_DEBOUNCE_MS);
    void drawingSetToolbarSettings(currentToolbarSettings());

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
    unsubSaveStatus?.();
    unsubSaveStatus = null;
    unsubToolbarSettings?.();
    unsubToolbarSettings = null;
    // Clear the dockview status row so closing the panel removes
    // its icons.
    clearNoteStatus(noteId);
    if (!mountedAndroid) return;
    // drawing_hide also signals the save worker to flush any
    // pending save immediately — so a "drew + navigated away
    // within the debounce window" gesture doesn't strand the
    // change. We don't await: the flush happens on the worker
    // thread asynchronously, and the next reopen of this note
    // will see the persisted bytes regardless.
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
