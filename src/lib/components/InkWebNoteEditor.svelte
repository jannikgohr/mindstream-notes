<script lang="ts">
  import * as Y from 'yjs';
  import { onDestroy, onMount, tick } from 'svelte';
  import {
    ClipboardPaste,
    Copy,
    Eraser,
    LassoSelect,
    Monitor,
    MousePointer2,
    MoonStar,
    Palette,
    PenLine,
    PocketKnife,
    Redo2,
    Scissors,
    Settings2,
    Sun,
    Shredder,
    Trash2,
    Undo2
  } from '@lucide/svelte';
  import { mode } from 'mode-watcher';
  import {
    Toolbar,
    ToolbarButton,
    ToolbarCollapseWhenOverflow,
    ToolbarSeparator,
    ToolbarZoomControls
  } from '$lib/components/ui/toolbar';
  import { confirm } from '$lib/components/confirm-dialog.svelte';
  import {
    drawingCancelLiveInk,
    drawingEnterImmersiveInkMode,
    drawingExitImmersiveInkMode,
    drawingHideLiveInkOverlay,
    drawingSaveInkState,
    drawingSetControlBounds,
    drawingSetDocumentBounds,
    drawingSetLiveInkFingerDrawing,
    drawingSetLiveInkStyle,
    drawingShowLiveInkOverlay,
    getYjsRelayUrl,
    loadNote,
    noteRoomInfo,
    onSessionChange,
    isTauri,
    TRASH_ID,
    type DrawingToolbarSettings,
    type DrawingToolbarSettingsPayload
  } from '$lib/api';
  import { isAndroid, isMobile } from '$lib/platform';
  import {
    PAGE_FIT_MARGIN,
    PAGE_FIT_TOP_MARGIN,
    canvasPageSurface
  } from '$lib/layout/page-layout';
  import { tUi, tValue } from '$lib/settings/i18n.svelte';
  import {
    getSettingValue,
    hasSettingValue,
    setSettingValue
  } from '$lib/settings/store.svelte';
  import {
    clearNoteStatus,
    setNoteStatus,
    type SavingState
  } from '$lib/stores/note-status.svelte';
  import {
    registerEditor,
    unregisterEditor,
    type EditorListener
  } from '$lib/hotkeys';
  import { tree } from '$lib/stores/tree.svelte';
  import { InkWebCollabProvider } from '$lib/sync/ink-web-collab-provider';
  import {
    DEFAULT_COLOR,
    DEFAULT_WIDTH,
    InkDocument,
    type InkStrokeInput,
    type StrokeBounds,
    type StrokeStylePatch,
    type StrokeTransform
  } from '$lib/ink/document';
  import {
    DEFAULT_PAGE_GAP,
    containsPagePoint,
    defaultLayout,
    pageCountForContentMaxY,
    pageRect,
    strideY,
    type DocumentLayout,
    type InkPoint
  } from '$lib/ink/page';
  import { acquireFullscreen, releaseFullscreen } from '$lib/window/fullscreen';

  interface Props {
    noteId: string;
    ariaLabel: string;
  }

  let { noteId, ariaLabel }: Props = $props();

  const SAVE_DEBOUNCE_MS = 800;
  const ERASER_RADIUS = 10;
  const PAGE_FILL_LIGHT = 0xffffffff;
  const TOOL_PREVIEW_DASH = [5, 4];
  const MAX_ZOOM_FACTOR = 6;
  const INK_ZOOM_DISPLAY_SCALE = 2;
  const INK_ZOOM_STEP = 1.2;
  const INK_QUICK_ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  const INK_COLOR_SWATCHES = [
    '#111827',
    '#dc2626',
    '#2563eb',
    '#16a34a',
    '#f59e0b',
    '#7c3aed'
  ];
  const POINTER_BUTTON_SECONDARY = 2;
  const POINTER_BUTTON_STYLUS_PRIMARY = 32;
  const POINTER_BUTTON_STYLUS_SECONDARY = 64;
  const SELECTION_HANDLE_RADIUS_PX = 7;
  const SELECTION_HANDLE_HIT_RADIUS_PX = 22;
  const SELECTION_ROTATE_GAP_PX = 30;
  const SELECTION_PASTE_OFFSET_PX = 24;

  const INK_TOOL_SETTING = 'editor.ink.tool';
  const INK_COLOR_SETTING = 'editor.ink.color';
  const INK_WIDTH_SETTING = 'editor.ink.width';
  const INK_FINGER_SETTING = 'editor.ink.fingerDrawing';
  const INK_PAGE_THEME_SETTING = 'editor.ink.pageTheme';

  type ToolMode = 'pen' | 'eraser' | 'lasso';
  type PageThemeMode = 'light' | 'dark' | 'system';
  type AndroidStylusEraserAction = 'down' | 'move' | 'up' | 'cancel';
  type AndroidStylusEraserPoint = {
    x: number;
    y: number;
    pressure?: number;
  };
  type AndroidStylusEraserPayload = {
    action: AndroidStylusEraserAction;
    points: AndroidStylusEraserPoint[];
  };
  type QueuedEraserSample = {
    point: InkPoint;
    hits: Set<string>;
  };
  type ToolPreview = {
    point: InkPoint;
    erasing: boolean;
    lassoing: boolean;
    pointerType: string;
  };
  type PointerMode =
    | 'draw'
    | 'erase'
    | 'lasso'
    | 'moveSelection'
    | 'pan'
    | 'touchGesture';
  type SelectionHandle = 'nw' | 'ne' | 'se' | 'sw' | 'rotate';
  type SelectionFrame = Record<
    Exclude<SelectionHandle, 'rotate'>,
    { x: number; y: number }
  >;
  type SelectionInteraction =
    | { kind: 'move'; start: InkPoint }
    | {
        kind: 'resize';
        handle: Exclude<SelectionHandle, 'rotate'>;
        anchor: { x: number; y: number };
        startCorner: { x: number; y: number };
      }
    | {
        kind: 'rotate';
        center: { x: number; y: number };
        startAngle: number;
      };
  type InkClipboardStroke = InkStrokeInput;
  type TouchPointer = {
    clientX: number;
    clientY: number;
    x: number;
    y: number;
  };
  type TouchGestureState = {
    centerX: number;
    centerY: number;
    distance: number;
  };
  type WebInkHandleInstance = {
    encode_state_vector: () => Uint8Array;
    encode_diff_for_state_vector: (stateVector: Uint8Array) => Uint8Array;
    apply_remote_update: (update: Uint8Array) => boolean;
  };

  let hostEl = $state<HTMLDivElement | null>(null);
  let canvasHostEl = $state<HTMLDivElement | null>(null);
  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let resizeSnapshotCanvasEl = $state<HTMLCanvasElement | null>(null);
  let toolbarEl = $state<HTMLDivElement | null>(null);
  let boundsFrame: number | null = null;
  let doc = $state<InkDocument | null>(null);
  let handle: WebInkHandleInstance | null = null;
  let provider: InkWebCollabProvider | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let disposed = false;
  let fullscreenAcquired = false;
  let immersiveInkModeActive = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingState: number[] | null = null;
  let pendingSaveUpdates: Uint8Array[] = [];
  let saveDirty = false;
  let saveInFlight = false;
  let toolbarSettingsReady = false;
  let savingState = $state<SavingState>('idle');
  let collabConfigured = $state(false);
  let collabOnline = $state(false);
  let collabReady = false;
  let lastSeenPushed = false;
  let unsubSession: (() => void) | null = null;
  let editorListener: EditorListener | null = null;
  let mobileToolbar = $state(false);
  let zoomMenuOpen = $state(false);
  let toolbarMenuOpen = $state<'style' | 'selection' | 'settings' | null>(null);
  let styleMenuButton = $state<HTMLButtonElement | null>(null);
  let styleMenuEl = $state<HTMLDivElement | null>(null);
  let selectionMenuButton = $state<HTMLButtonElement | null>(null);
  let selectionMenuEl = $state<HTMLDivElement | null>(null);
  let settingsMenuButton = $state<HTMLButtonElement | null>(null);
  let settingsMenuEl = $state<HTMLDivElement | null>(null);
  let zoomUiVersion = $state(0);

  let tool = $state<ToolMode>('pen');
  let colorArgb = $state(DEFAULT_COLOR);
  let colorInputText = $state('#000000');
  let width = $state(DEFAULT_WIDTH);
  let fingerDrawingAllowed = $state(true);
  let pageThemeMode = $state<PageThemeMode>('light');
  let strokeCount = $state(0);
  let selectedStrokeIds = $state<string[]>([]);
  let selectionClipboard = $state<InkClipboardStroke[]>([]);
  let selectionFrame = $state<SelectionFrame | null>(null);
  let inFlight = $state<InkPoint[]>([]);
  let lassoPoints = $state<InkPoint[]>([]);
  let selectionDragStart: InkPoint | null = null;
  let selectionDragOffset = $state({ x: 0, y: 0 });
  let selectionInteraction: SelectionInteraction | null = null;
  let selectionTransformPreview = $state(identityTransform());
  let undoDepth = $state(0);
  let redoDepth = $state(0);
  let eraserHits = new Set<string>();
  let androidStylusEraserHits = new Set<string>();
  let androidStylusEraserActive = false;
  let pointerMode: PointerMode | null = null;
  let activePointerId: number | null = null;
  let toolPreview = $state<ToolPreview | null>(null);
  let lastPointer: { x: number; y: number } | null = null;
  const touchPointers = new Map<number, TouchPointer>();
  let touchGesture: TouchGestureState | null = null;
  let drawingStrokeActive = false;
  let queuedEraserSamples: QueuedEraserSample[] = [];
  let eraserFrame: number | null = null;
  let drawFrame: number | null = null;
  let resizeSnapshotHideTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeSnapshotVisible = $state(false);
  let hasDrawnFrame = false;
  let viewInitialized = false;
  const cssColorCache = new Map<number, string>();
  let layout = defaultLayout();
  let view = {
    width: 1,
    height: 1,
    scale: 1,
    panX: 0,
    panY: DEFAULT_PAGE_GAP
  };

  const pageDark = $derived(
    pageThemeMode === 'dark' || (pageThemeMode === 'system' && $mode === 'dark')
  );
  const colorHex = $derived(argbToColorHex(colorArgb));
  const inkZoomLabel = $derived.by(() => {
    void zoomUiVersion;
    return `${Math.round(displayInkZoom(view.scale) * 100)}%`;
  });
  const inkFitActive = $derived.by(() => {
    void zoomUiVersion;
    return Math.abs(view.scale - fitWidthScale()) < 0.01;
  });
  const brushLineHeight = $derived(Math.max(2, Math.min(12, width)));
  const brushSizeText = $derived(
    Number.isInteger(width) ? String(width) : width.toFixed(1)
  );
  const selectedStrokeSet = $derived(new Set(selectedStrokeIds));
  const hasSelection = $derived(selectedStrokeIds.length > 0);
  const hasSelectionClipboard = $derived(selectionClipboard.length > 0);
  const selectionMoveActive = $derived(
    Math.abs(selectionDragOffset.x) > 0.001 ||
      Math.abs(selectionDragOffset.y) > 0.001 ||
      !transformIsIdentity(selectionTransformPreview)
  );
  const clearButtonLabel = $derived(tUi('ink.toolbar.clear'));

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

  $effect(() => {
    setNoteStatus(noteId, {
      collabConfigured,
      collabOnline,
      savingState,
      isTrashed
    });
  });

  $effect(() => {
    const pushed = tree.notesById[noteId]?.pushed ?? false;
    if (!collabReady) return;
    if (pushed === lastSeenPushed) return;
    lastSeenPushed = pushed;
    void setupCollabProvider();
  });

  $effect(() => {
    tool = normalizeInkTool(getSettingValue(INK_TOOL_SETTING));
    colorArgb = colorHexToArgb(getSettingValue(INK_COLOR_SETTING));
    width = normalizeInkWidth(getSettingValue(INK_WIDTH_SETTING));
    fingerDrawingAllowed = hasSettingValue(INK_FINGER_SETTING)
      ? Boolean(getSettingValue(INK_FINGER_SETTING))
      : true;
    pageThemeMode = normalizeInkPageTheme(
      getSettingValue(INK_PAGE_THEME_SETTING)
    );
  });

  $effect(() => {
    colorInputText = colorHex;
  });

  $effect(() => {
    strokeCount;
    inFlight;
    tool;
    colorArgb;
    width;
    // Read the resolved value (not just the mode) so a live app-theme
    // flip repaints the page while "follow app theme" is selected.
    pageDark;
    scheduleDraw();
  });

  function updateLiveInkOverlayStyle() {
    if (!isAndroid()) return;
    if (tool !== 'pen') {
      void drawingCancelLiveInk();
    }
    const maxWidthPx = Math.max(0.5, width * view.scale);
    const minWidthPx = Math.max(0.5, maxWidthPx * 0.25);
    const liveColorArgb = tool === 'pen' ? colorArgb : 0x00000000;
    const liveFingerDrawingAllowed =
      pointerMode === 'touchGesture' ? false : fingerDrawingAllowed;
    void drawingSetLiveInkStyle(liveColorArgb, minWidthPx, maxWidthPx);
    void drawingSetLiveInkFingerDrawing(liveFingerDrawingAllowed);
  }

  /**
   * Collect the bounds of any UI element that should be excluded from
   * live-ink rendering — the toolbar at minimum. Returned as a flat
   * float list of [x0, y0, x1, y1] quads in webview-local surface
   * pixels, the format Kotlin's `setControlBoundsFromNative` expects.
   */
  function collectControlBounds(): number[] {
    if (!toolbarEl) return [];
    const dpr = window.devicePixelRatio || 1;
    const rect = toolbarEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return [];
    return [
      rect.left * dpr,
      rect.top * dpr,
      rect.right * dpr,
      rect.bottom * dpr
    ];
  }

  /**
   * Collect the visible page rects in webview-local surface pixels so
   * the Android overlay can refuse to paint outside the document area
   * — same allow-region the JS canvas enforces with `containsPagePoint`.
   * Returns an empty list when the layout isn't ready yet or the note
   * is trashed; Kotlin treats empty as "block all painting".
   */
  function collectDocumentBounds(): number[] {
    if (!canvasEl || isTrashed) return [];
    const canvasRect = canvasEl.getBoundingClientRect();
    if (canvasRect.width <= 0 || canvasRect.height <= 0) return [];
    const dpr = window.devicePixelRatio || 1;
    const bounds: number[] = [];
    for (let i = 0; i < layout.pageCount; i++) {
      const rect = pageRect(layout, i);
      if (!rect) continue;
      const [x0p, y0p, x1p, y1p] = rect;
      const tl = pageToScreen({ x: x0p, y: y0p });
      const br = pageToScreen({ x: x1p, y: y1p });
      // Clip to the visible canvas area; off-canvas portions are
      // already invisible and would just waste Kotlin's rect test.
      const left = Math.max(tl.x, 0);
      const top = Math.max(tl.y, 0);
      const right = Math.min(br.x, view.width);
      const bottom = Math.min(br.y, view.height);
      if (right <= left || bottom <= top) continue;
      bounds.push(
        (canvasRect.left + left) * dpr,
        (canvasRect.top + top) * dpr,
        (canvasRect.left + right) * dpr,
        (canvasRect.top + bottom) * dpr
      );
    }
    return bounds;
  }

  /**
   * Push the current UI control + document bounds to the Android live
   * overlay. Coalesced via requestAnimationFrame so a burst of
   * scheduleDraw / ResizeObserver / visualViewport events only produces
   * one IPC pair per frame.
   */
  function scheduleBoundsPush() {
    if (!isAndroid() || disposed) return;
    if (boundsFrame !== null) return;
    boundsFrame = requestAnimationFrame(() => {
      boundsFrame = null;
      void drawingSetDocumentBounds(collectDocumentBounds()).catch((err) => {
        console.warn('[ink-canvas] failed to push document bounds', err);
      });
      void drawingSetControlBounds(collectControlBounds()).catch((err) => {
        console.warn('[ink-canvas] failed to push control bounds', err);
      });
    });
  }

  function currentToolbarSettings(): DrawingToolbarSettings {
    return {
      tool,
      colorArgb,
      width,
      fingerDrawingAllowed,
      pageThemeMode
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

  function emitToolbarSettings() {
    if (!toolbarSettingsReady) return;
    void saveToolbarSettings({
      tool,
      colorArgb,
      width,
      fingerDrawingAllowed,
      pageThemeMode
    }).catch((err) => {
      console.warn('[ink-canvas-toolbar] failed to save settings', err);
    });
  }

  function clearSaveTimer() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  async function flushPendingState() {
    saveTimer = null;
    if (
      (!saveDirty && !pendingState && pendingSaveUpdates.length === 0) ||
      disposed
    ) {
      return;
    }
    if (saveInFlight) {
      scheduleSave();
      return;
    }

    const updates = pendingSaveUpdates;
    const state =
      pendingState ??
      (updates.length > 0
        ? Array.from(Y.mergeUpdates(updates))
        : doc
          ? Array.from(doc.encode())
          : null);
    if (!state) return;
    pendingState = null;
    pendingSaveUpdates = [];
    saveDirty = false;
    saveInFlight = true;
    savingState = 'saving';
    try {
      await drawingSaveInkState(noteId, state);
      savingState =
        saveDirty || pendingSaveUpdates.length > 0 || pendingState
          ? 'pending'
          : 'saved';
    } catch (err) {
      if (!saveDirty && pendingSaveUpdates.length === 0) {
        pendingState = state;
      } else {
        pendingSaveUpdates = [new Uint8Array(state), ...pendingSaveUpdates];
      }
      savingState =
        saveDirty || pendingSaveUpdates.length > 0 || pendingState
          ? 'pending'
          : 'error';
      console.warn('[ink-canvas] failed to save note', err);
    } finally {
      saveInFlight = false;
      if (
        !disposed &&
        (saveDirty || pendingState || pendingSaveUpdates.length > 0) &&
        saveTimer === null
      ) {
        saveTimer = setTimeout(
          () => void flushPendingState(),
          SAVE_DEBOUNCE_MS
        );
      }
    }
  }

  function scheduleSave() {
    if (!doc && pendingSaveUpdates.length === 0 && !pendingState) return;
    saveDirty = true;
    pendingState = null;
    savingState = 'pending';
    clearSaveTimer();
    saveTimer = setTimeout(() => void flushPendingState(), SAVE_DEBOUNCE_MS);
  }

  function queueSaveUpdates(updates: Uint8Array[]) {
    for (const update of updates) {
      if (update.byteLength > 0) {
        pendingSaveUpdates.push(update);
      }
    }
    scheduleSave();
  }

  function applyDocumentMutation(update: Uint8Array | null) {
    applyDocumentMutations(update ? [update] : []);
  }

  function applyDocumentMutations(updates: Uint8Array[]) {
    refreshFromDoc();
    if (updates.length > 0) {
      queueSaveUpdates(updates);
    }
    for (const update of updates) {
      provider?.sendLocalUpdate(update);
    }
  }

  function refreshFromDoc() {
    if (!doc) return;
    strokeCount = doc.visibleStrokeCount();
    pruneSelection();
    syncHistoryState();
    const maxY = doc.contentMaxY();
    layout = defaultLayout(pageCountForContentMaxY(maxY));
    clampView();
    scheduleDraw();
  }

  function pruneSelection() {
    if (!doc || selectedStrokeIds.length === 0) return;
    const visible = new Set(doc.strokeIds(false).map((entry) => entry.id));
    const next = selectedStrokeIds.filter((id) => visible.has(id));
    if (next.length !== selectedStrokeIds.length) {
      selectedStrokeIds = next;
      selectionFrame = null;
      if (next.length > 0) {
        const bounds = selectionBounds();
        selectionFrame = bounds ? frameFromBounds(bounds) : null;
      }
    }
  }

  function syncHistoryState() {
    undoDepth = doc?.undo.length ?? 0;
    redoDepth = doc?.redo.length ?? 0;
  }

  async function setupCollabProvider(): Promise<void> {
    provider?.destroy();
    provider = null;
    collabOnline = false;
    collabConfigured = false;
    console.info('[ink-collab] reset note=%s', noteId);

    // Derived from the single account.serverUrl setting: nginx routes
    // /yjs to the yjs-relay upstream (see backend/nginx/nginx.conf).
    const collabUrl = getYjsRelayUrl(
      (getSettingValue('account.serverUrl') as string | undefined) ?? ''
    );
    if (!collabUrl || !handle) {
      if (!collabUrl) {
        console.info('[ink-collab] disabled note=%s (no relay URL)', noteId);
      }
      return;
    }

    try {
      const room = await noteRoomInfo(noteId);
      if (!room) {
        console.info(
          '[ink-collab] no room note=%s (not pushed, no session, or missing key)',
          noteId
        );
        return;
      }
      collabConfigured = true;
      provider = new InkWebCollabProvider({
        url: collabUrl,
        roomId: room.room_id,
        keyBytes: base64ToBytes(room.key_b64),
        handle,
        noteId,
        onStatusChange: (online) => {
          collabOnline = online;
          console.info(
            '[ink-collab] status note=%s configured=%s online=%s',
            noteId,
            collabConfigured,
            online
          );
        }
      });
    } catch (err) {
      console.debug('[InkWebNoteEditor] collab provider init failed', err);
    }
  }

  function resizeCanvas() {
    if (!canvasHostEl || !canvasEl) return;
    const wasAtFitWidth = view.scale <= fitWidthScale() + 0.001;
    const rect = canvasHostEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const widthPx = Math.max(1, Math.floor(rect.width * dpr));
    const heightPx = Math.max(1, Math.floor(rect.height * dpr));
    const backingStoreChanged =
      canvasEl.width !== widthPx || canvasEl.height !== heightPx;
    if (backingStoreChanged) {
      captureResizeSnapshot();
      canvasEl.width = widthPx;
      canvasEl.height = heightPx;
    }
    view.width = rect.width;
    view.height = rect.height;
    const nextMinScale = minScale();
    if (!viewInitialized || wasAtFitWidth) {
      fitWidth();
      viewInitialized = true;
    } else {
      view.scale = Math.max(view.scale, nextMinScale);
      clampView();
    }
    if (backingStoreChanged) {
      if (drawFrame !== null) {
        cancelAnimationFrame(drawFrame);
        drawFrame = null;
      }
      draw();
      scheduleBoundsPush();
    } else {
      scheduleDraw();
    }
    updateLiveInkOverlayStyle();
    zoomUiVersion += 1;
  }

  function captureResizeSnapshot() {
    if (
      !hasDrawnFrame ||
      !canvasEl ||
      !resizeSnapshotCanvasEl ||
      canvasEl.width <= 1 ||
      canvasEl.height <= 1
    ) {
      return;
    }
    const ctx = resizeSnapshotCanvasEl.getContext('2d');
    if (!ctx) return;
    if (
      resizeSnapshotCanvasEl.width !== canvasEl.width ||
      resizeSnapshotCanvasEl.height !== canvasEl.height
    ) {
      resizeSnapshotCanvasEl.width = canvasEl.width;
      resizeSnapshotCanvasEl.height = canvasEl.height;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(
      0,
      0,
      resizeSnapshotCanvasEl.width,
      resizeSnapshotCanvasEl.height
    );
    ctx.drawImage(canvasEl, 0, 0);
    resizeSnapshotVisible = true;
    resizeSnapshotCanvasEl.style.opacity = '1';
    if (resizeSnapshotHideTimer) {
      clearTimeout(resizeSnapshotHideTimer);
      resizeSnapshotHideTimer = null;
    }
  }

  function scheduleResizeSnapshotHide() {
    if (!resizeSnapshotVisible) return;
    if (resizeSnapshotHideTimer) clearTimeout(resizeSnapshotHideTimer);
    resizeSnapshotHideTimer = setTimeout(() => {
      resizeSnapshotHideTimer = null;
      resizeSnapshotVisible = false;
      if (resizeSnapshotCanvasEl) resizeSnapshotCanvasEl.style.opacity = '';
    }, 120);
  }

  // Default view: fill the column width with the A4 page, exactly like
  // the PDF viewer's fit-width. The page overflows vertically and is
  // scrolled/panned; zooming out below this reaches the whole-page floor
  // (minScale). Mirrors PdfNoteViewer's fit-width zoom + PAGE_FIT_MARGIN
  // gutters so both renderers frame an A4 sheet identically.
  function fitWidthScale(): number {
    const availableWidth = Math.max(1, view.width - PAGE_FIT_MARGIN * 2);
    return Math.max(minScale(), availableWidth / layout.page.width);
  }

  function displayInkZoom(scale: number): number {
    return scale * INK_ZOOM_DISPLAY_SCALE;
  }

  function scaleFromDisplayInkZoom(value: number): number {
    return value / INK_ZOOM_DISPLAY_SCALE;
  }

  function fitWidth() {
    view.scale = fitWidthScale();
    view.panX = (view.width - layout.page.width * view.scale) * 0.5;
    // Top-align the first page with the same gutter the sides get.
    view.panY = PAGE_FIT_MARGIN;
    clampView();
  }

  function clampView() {
    view.scale = Math.max(view.scale, minScale());
    const contentW = layout.page.width * view.scale;
    const contentH =
      (layout.page.height * layout.pageCount +
        layout.pageGap * (layout.pageCount - 1)) *
      view.scale;
    if (contentW <= view.width) {
      view.panX = (view.width - contentW) * 0.5;
    } else {
      view.panX = Math.min(16, Math.max(view.width - contentW - 16, view.panX));
    }
    const bottomMargin = Math.max(PAGE_FIT_MARGIN, layout.pageGap * view.scale);
    const topMargin = mobileToolbar
      ? Math.max(PAGE_FIT_TOP_MARGIN, bottomMargin)
      : PAGE_FIT_MARGIN;
    const minY = view.height - contentH - bottomMargin;
    const maxY = topMargin;
    view.panY =
      minY <= maxY
        ? Math.min(maxY, Math.max(minY, view.panY))
        : (view.height - contentH) * 0.5;
  }

  function screenToPage(x: number, y: number): InkPoint {
    return {
      x: (x - view.panX) / view.scale,
      y: (y - view.panY) / view.scale,
      pressure: 1
    };
  }

  function pageToScreen(p: { x: number; y: number }): { x: number; y: number } {
    return {
      x: p.x * view.scale + view.panX,
      y: p.y * view.scale + view.panY
    };
  }

  function scheduleDraw() {
    if (drawFrame === null) {
      drawFrame = requestAnimationFrame(() => {
        drawFrame = null;
        draw();
      });
    }
    // Pan / zoom / page-count changes go through scheduleDraw, so
    // piggy-back the bounds push here. The bounds push has its own rAF
    // guard, so the over-eager calls from strokeCount / tool / colour
    // change effects coalesce to at most one IPC pair per frame.
    scheduleBoundsPush();
  }

  function draw() {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const visibleBounds = visiblePageBounds();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Canvas stays transparent so the wrapper's `bg-background` shows
    // through — that's how Ink picks up the shared editor surround.
    ctx.clearRect(0, 0, view.width, view.height);

    drawPages(ctx, visibleBounds);
    const visibleStrokes = doc?.visibleStrokesInBounds(visibleBounds, 2) ?? [];
    for (const stroke of visibleStrokes) {
      if (selectionMoveActive && selectedStrokeSet.has(stroke.id)) continue;
      drawStroke(
        ctx,
        stroke.points,
        displayCssColor(stroke.color),
        stroke.width
      );
    }
    if (selectionMoveActive) {
      const transform = currentSelectionTransform();
      for (const stroke of visibleStrokes) {
        if (!selectedStrokeSet.has(stroke.id)) continue;
        drawStroke(
          ctx,
          transformedPoints(stroke.points, transform),
          displayCssColor(stroke.color),
          stroke.width * transform.widthScale
        );
      }
    }
    drawStroke(ctx, inFlight, displayCssColor(colorArgb), width);
    drawSelectionOverlay(ctx);
    drawLassoOverlay(ctx);
    drawToolPreview(ctx);
    hasDrawnFrame = true;
    scheduleResizeSnapshotHide();
  }

  function visiblePageBounds(): StrokeBounds {
    return {
      minX: -view.panX / view.scale,
      minY: -view.panY / view.scale,
      maxX: (view.width - view.panX) / view.scale,
      maxY: (view.height - view.panY) / view.scale
    };
  }

  function drawPages(ctx: CanvasRenderingContext2D, visible: StrokeBounds) {
    const stride = strideY(layout);
    const firstPage = Math.max(0, Math.floor(visible.minY / stride) - 1);
    const lastPage = Math.min(
      layout.pageCount - 1,
      Math.floor(visible.maxY / stride) + 1
    );
    for (let i = firstPage; i <= lastPage; i += 1) {
      const rect = pageRect(layout, i);
      if (!rect) continue;
      const [x0, y0, x1, y1] = rect;
      const a = pageToScreen({ x: x0, y: y0 });
      const b = pageToScreen({ x: x1, y: y1 });
      if (b.y < -32 || a.y > view.height + 32) continue;
      const width = b.x - a.x;
      const height = b.y - a.y;
      const surface = canvasPageSurface(pageDark);
      ctx.save();
      ctx.shadowColor = surface.shadowColor;
      ctx.shadowBlur = surface.shadowBlur;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = surface.shadowOffsetY;
      ctx.fillStyle = displayCssColor(PAGE_FILL_LIGHT);
      ctx.fillRect(a.x, a.y, width, height);
      ctx.restore();
      ctx.strokeStyle = surface.edgeColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(a.x + 0.5, a.y + 0.5, width - 1, height - 1);
    }
  }

  function drawToolPreview(ctx: CanvasRenderingContext2D) {
    if (
      !toolPreview ||
      pointerMode === 'pan' ||
      pointerMode === 'touchGesture'
    ) {
      return;
    }
    const onPage = containsPagePoint(
      layout,
      toolPreview.point.x,
      toolPreview.point.y
    );
    if (!toolPreview.erasing && !toolPreview.lassoing && !onPage) {
      return;
    }
    const center = pageToScreen(toolPreview.point);
    ctx.save();
    ctx.lineWidth = 1;
    if (toolPreview.erasing) {
      const radius = Math.max(4, ERASER_RADIUS * view.scale);
      ctx.setLineDash(TOOL_PREVIEW_DASH);
      ctx.beginPath();
      ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = onPage
        ? pageDark
          ? 'rgba(248, 250, 252, 0.08)'
          : 'rgba(15, 23, 42, 0.06)'
        : 'rgba(248, 250, 252, 0.08)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(248, 250, 252, 0.78)';
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.78)';
      ctx.stroke();
    } else if (toolPreview.lassoing && lassoPoints.length === 0) {
      const radiusX = 15;
      const radiusY = 11;
      ctx.setLineDash(TOOL_PREVIEW_DASH);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = pageDark
        ? 'rgba(96, 165, 250, 0.9)'
        : 'rgba(37, 99, 235, 0.82)';
      ctx.fillStyle = pageDark
        ? 'rgba(96, 165, 250, 0.1)'
        : 'rgba(37, 99, 235, 0.07)';
      ctx.beginPath();
      ctx.ellipse(center.x, center.y, radiusX, radiusY, -0.24, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if (shouldDrawPenToolPreview()) {
      const radius = Math.max(2, (width * view.scale) / 2);
      const previewColor = displayColor(colorArgb);
      ctx.strokeStyle = cssColor(previewColor);
      ctx.fillStyle = cssColor(
        (0x33000000 | (previewColor & 0x00ffffff)) >>> 0
      );
      ctx.beginPath();
      ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function shouldDrawPenToolPreview(): boolean {
    if (toolPreview?.pointerType !== 'pen') return false;
    return !(isAndroid() && pointerMode === 'draw');
  }

  function drawStroke(
    ctx: CanvasRenderingContext2D,
    points: InkPoint[],
    color: string,
    baseWidth: number
  ) {
    if (points.length < 2) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    const scale = view.scale;
    const panX = view.panX;
    const panY = view.panY;
    let previous = points[0];
    let previousX = previous.x * scale + panX;
    let previousY = previous.y * scale + panY;
    let currentWidth = 0;
    let pathOpen = false;

    for (let i = 1; i < points.length; i += 1) {
      const point = points[i];
      const x = point.x * scale + panX;
      const y = point.y * scale + panY;
      const pressure = (previous.pressure + point.pressure) * 0.5;
      const lineWidth = Math.max(
        1,
        baseWidth * scale * pressureWidth(pressure)
      );
      const quantizedWidth = Math.round(lineWidth * 4) / 4;
      if (!pathOpen || quantizedWidth !== currentWidth) {
        if (pathOpen) {
          ctx.stroke();
        }
        ctx.lineWidth = quantizedWidth;
        ctx.beginPath();
        ctx.moveTo(previousX, previousY);
        currentWidth = quantizedWidth;
        pathOpen = true;
      }
      ctx.lineTo(x, y);
      previous = point;
      previousX = x;
      previousY = y;
    }
    if (pathOpen) {
      ctx.stroke();
    }
  }

  function pressureWidth(pressure: number): number {
    return 0.25 + 0.75 * Math.min(1, Math.max(0, pressure));
  }

  function identityTransform(): StrokeTransform {
    return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, widthScale: 1 };
  }

  function translationTransform(dx: number, dy: number): StrokeTransform {
    return { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy, widthScale: 1 };
  }

  function transformIsIdentity(transform: StrokeTransform): boolean {
    return (
      Math.abs(transform.a - 1) < 0.0001 &&
      Math.abs(transform.b) < 0.0001 &&
      Math.abs(transform.c) < 0.0001 &&
      Math.abs(transform.d - 1) < 0.0001 &&
      Math.abs(transform.e) < 0.001 &&
      Math.abs(transform.f) < 0.001 &&
      Math.abs(transform.widthScale - 1) < 0.0001
    );
  }

  function currentSelectionTransform(): StrokeTransform {
    if (!transformIsIdentity(selectionTransformPreview)) {
      return selectionTransformPreview;
    }
    return translationTransform(selectionDragOffset.x, selectionDragOffset.y);
  }

  function transformPoint(
    point: { x: number; y: number },
    transform: StrokeTransform
  ): { x: number; y: number } {
    return {
      x: point.x * transform.a + point.y * transform.c + transform.e,
      y: point.x * transform.b + point.y * transform.d + transform.f
    };
  }

  function resizeTransform(
    anchor: { x: number; y: number },
    startCorner: { x: number; y: number },
    current: { x: number; y: number }
  ): StrokeTransform {
    const minScale = 0.08;
    const sxBase = startCorner.x - anchor.x;
    const syBase = startCorner.y - anchor.y;
    const rawSx =
      Math.abs(sxBase) < 0.001 ? 1 : (current.x - anchor.x) / sxBase;
    const rawSy =
      Math.abs(syBase) < 0.001 ? 1 : (current.y - anchor.y) / syBase;
    const sx = Math.max(minScale, rawSx);
    const sy = Math.max(minScale, rawSy);
    return {
      a: sx,
      b: 0,
      c: 0,
      d: sy,
      e: anchor.x - anchor.x * sx,
      f: anchor.y - anchor.y * sy,
      widthScale: Math.sqrt(Math.max(minScale * minScale, sx * sy))
    };
  }

  function rotationTransform(
    center: { x: number; y: number },
    angle: number
  ): StrokeTransform {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
      a: cos,
      b: sin,
      c: -sin,
      d: cos,
      e: center.x - center.x * cos + center.y * sin,
      f: center.y - center.x * sin - center.y * cos,
      widthScale: 1
    };
  }

  function transformedPoints(
    points: InkPoint[],
    transform: StrokeTransform
  ): InkPoint[] {
    return points.map((point) => ({
      ...transformPoint(point, transform),
      pressure: point.pressure
    }));
  }

  function selectionBounds(): StrokeBounds | null {
    if (!doc || selectedStrokeIds.length === 0) return null;
    const selected = selectedStrokeSet;
    let out: StrokeBounds | null = null;
    for (const stroke of doc.visibleStrokes()) {
      if (!selected.has(stroke.id) || !stroke.bounds) continue;
      out = out
        ? {
            minX: Math.min(out.minX, stroke.bounds.minX),
            minY: Math.min(out.minY, stroke.bounds.minY),
            maxX: Math.max(out.maxX, stroke.bounds.maxX),
            maxY: Math.max(out.maxY, stroke.bounds.maxY)
          }
        : { ...stroke.bounds };
    }
    return out;
  }

  function frameFromBounds(bounds: StrokeBounds): SelectionFrame {
    return {
      nw: { x: bounds.minX, y: bounds.minY },
      ne: { x: bounds.maxX, y: bounds.minY },
      se: { x: bounds.maxX, y: bounds.maxY },
      sw: { x: bounds.minX, y: bounds.maxY }
    };
  }

  function transformSelectionFrame(
    frame: SelectionFrame,
    transform: StrokeTransform
  ): SelectionFrame {
    return {
      nw: transformPoint(frame.nw, transform),
      ne: transformPoint(frame.ne, transform),
      se: transformPoint(frame.se, transform),
      sw: transformPoint(frame.sw, transform)
    };
  }

  function baseSelectionFrame(): SelectionFrame | null {
    if (selectionFrame) return selectionFrame;
    const bounds = selectionBounds();
    return bounds ? frameFromBounds(bounds) : null;
  }

  function currentSelectionFrame(): SelectionFrame | null {
    const frame = baseSelectionFrame();
    if (!frame) return null;
    return transformSelectionFrame(frame, currentSelectionTransform());
  }

  function selectionCenter(frame: SelectionFrame): { x: number; y: number } {
    return {
      x: (frame.nw.x + frame.ne.x + frame.se.x + frame.sw.x) * 0.25,
      y: (frame.nw.y + frame.ne.y + frame.se.y + frame.sw.y) * 0.25
    };
  }

  function selectionContainsPoint(point: { x: number; y: number }): boolean {
    const corners = currentSelectionFrame();
    if (!corners) return false;
    return pointInPolygon(point, [
      corners.nw,
      corners.ne,
      corners.se,
      corners.sw
    ]);
  }

  function selectionScreenGeometry(): {
    corners: Record<
      Exclude<SelectionHandle, 'rotate'>,
      { x: number; y: number }
    >;
    rotate: { x: number; y: number };
  } | null {
    const corners = currentSelectionFrame();
    if (!corners) return null;
    const screenCorners = {
      nw: pageToScreen(corners.nw),
      ne: pageToScreen(corners.ne),
      se: pageToScreen(corners.se),
      sw: pageToScreen(corners.sw)
    };
    const topMid = {
      x: (screenCorners.nw.x + screenCorners.ne.x) * 0.5,
      y: (screenCorners.nw.y + screenCorners.ne.y) * 0.5
    };
    const center = pageToScreen(selectionCenter(corners));
    const normal = {
      x: topMid.x - center.x,
      y: topMid.y - center.y
    };
    const len = Math.max(1, Math.hypot(normal.x, normal.y));
    return {
      corners: screenCorners,
      rotate: {
        x: topMid.x + (normal.x / len) * SELECTION_ROTATE_GAP_PX,
        y: topMid.y + (normal.y / len) * SELECTION_ROTATE_GAP_PX
      }
    };
  }

  function selectionHandleAtCanvasPoint(point: {
    x: number;
    y: number;
  }): SelectionHandle | null {
    const geometry = selectionScreenGeometry();
    if (!geometry) return null;
    const handles: Array<[SelectionHandle, { x: number; y: number }]> = [
      ['rotate', geometry.rotate],
      ['nw', geometry.corners.nw],
      ['ne', geometry.corners.ne],
      ['se', geometry.corners.se],
      ['sw', geometry.corners.sw]
    ];
    for (const [handle, handlePoint] of handles) {
      if (
        Math.hypot(point.x - handlePoint.x, point.y - handlePoint.y) <=
        SELECTION_HANDLE_HIT_RADIUS_PX
      ) {
        return handle;
      }
    }
    return null;
  }

  function pointInPolygon(
    point: { x: number; y: number },
    polygon: Array<{ x: number; y: number }>
  ): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i];
      const b = polygon[j];
      const intersects =
        a.y > point.y !== b.y > point.y &&
        point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function drawSelectionOverlay(ctx: CanvasRenderingContext2D) {
    const geometry = selectionScreenGeometry();
    if (!geometry) return;
    const { corners, rotate } = geometry;
    const topMid = {
      x: (corners.nw.x + corners.ne.x) * 0.5,
      y: (corners.nw.y + corners.ne.y) * 0.5
    };
    ctx.save();
    ctx.strokeStyle = '#2563eb';
    ctx.fillStyle = 'rgba(37, 99, 235, 0.08)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(corners.nw.x, corners.nw.y);
    ctx.lineTo(corners.ne.x, corners.ne.y);
    ctx.lineTo(corners.se.x, corners.se.y);
    ctx.lineTo(corners.sw.x, corners.sw.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(topMid.x, topMid.y);
    ctx.lineTo(rotate.x, rotate.y);
    ctx.stroke();
    for (const point of [
      corners.nw,
      corners.ne,
      corners.se,
      corners.sw,
      rotate
    ]) {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(point.x, point.y, SELECTION_HANDLE_RADIUS_PX, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawLassoOverlay(ctx: CanvasRenderingContext2D) {
    if (lassoPoints.length < 2) return;
    ctx.save();
    ctx.strokeStyle = '#2563eb';
    ctx.fillStyle = 'rgba(37, 99, 235, 0.06)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    const start = pageToScreen(lassoPoints[0]);
    ctx.moveTo(start.x, start.y);
    for (const point of lassoPoints.slice(1)) {
      const screen = pageToScreen(point);
      ctx.lineTo(screen.x, screen.y);
    }
    if (lassoPoints.length > 2) {
      ctx.closePath();
      ctx.fill();
    }
    ctx.stroke();
    ctx.restore();
  }

  function pointerSamples(event: PointerEvent): PointerEvent[] {
    const samples = event.getCoalescedEvents?.() ?? [];
    return samples.length > 0 ? samples : [event];
  }

  function canvasPoint(
    clientX: number,
    clientY: number
  ): { x: number; y: number } {
    const rect = canvasEl?.getBoundingClientRect();
    return {
      x: clientX - (rect?.left ?? 0),
      y: clientY - (rect?.top ?? 0)
    };
  }

  function touchPointer(event: PointerEvent): TouchPointer {
    const point = canvasPoint(event.clientX, event.clientY);
    return {
      clientX: event.clientX,
      clientY: event.clientY,
      x: point.x,
      y: point.y
    };
  }

  function clientPoint(
    clientX: number,
    clientY: number,
    pressure: number
  ): InkPoint {
    const point = canvasPoint(clientX, clientY);
    const p = screenToPage(point.x, point.y);
    p.pressure = sanitizePressure(pressure);
    return p;
  }

  function eventPoint(event: PointerEvent): InkPoint {
    return clientPoint(event.clientX, event.clientY, event.pressure);
  }

  function updateToolPreview(event: PointerEvent) {
    if (event.pointerType === 'touch' || !canvasEl) return;
    const point = eventPoint(event);
    const erasing = tool === 'eraser' || isStylusButtonErasing(event);
    const lassoing = tool === 'lasso';
    const penHover = tool === 'pen' && event.pointerType === 'pen';
    const onPage = containsPagePoint(layout, point.x, point.y);
    if (
      (!erasing && !lassoing && !penHover) ||
      (!erasing && !lassoing && !onPage)
    ) {
      clearToolPreview();
      return;
    }
    toolPreview = { point, erasing, lassoing, pointerType: event.pointerType };
    scheduleDraw();
  }

  function clearToolPreview() {
    if (!toolPreview) return;
    toolPreview = null;
    scheduleDraw();
  }

  function isStylusButtonErasing(event: PointerEvent): boolean {
    if (event.pointerType !== 'pen') return false;
    const eraserButtons =
      POINTER_BUTTON_SECONDARY |
      POINTER_BUTTON_STYLUS_PRIMARY |
      POINTER_BUTTON_STYLUS_SECONDARY;
    return (
      event.button === 2 ||
      event.button === 5 ||
      (event.buttons & eraserButtons) !== 0
    );
  }

  function currentTouchGesture(): TouchGestureState | null {
    const pointers = [...touchPointers.values()];
    if (pointers.length < 2) return null;
    const a = pointers[0];
    const b = pointers[1];
    return {
      centerX: (a.x + b.x) * 0.5,
      centerY: (a.y + b.y) * 0.5,
      distance: Math.hypot(a.x - b.x, a.y - b.y)
    };
  }

  function beginTouchGesture() {
    if (pointerMode === 'draw') {
      cancelActiveStroke();
      inFlight = [];
    } else if (pointerMode === 'erase' && doc) {
      flushQueuedEraserSamples();
      doc.finishEraserDrag(eraserHits);
      syncHistoryState();
    } else if (pointerMode === 'lasso') {
      lassoPoints = [];
      selectedStrokeIds = [];
      selectionFrame = null;
    } else if (pointerMode === 'moveSelection') {
      cancelSelectionMove();
    }
    pointerMode = 'touchGesture';
    activePointerId = null;
    lastPointer = null;
    touchGesture = currentTouchGesture();
    if (isAndroid()) {
      void drawingCancelLiveInk();
      void drawingSetLiveInkFingerDrawing(false);
    }
  }

  function updateTouchGesture() {
    const next = currentTouchGesture();
    if (!next) return;
    if (!touchGesture || touchGesture.distance <= 0 || next.distance <= 0) {
      touchGesture = next;
      return;
    }
    const before = screenToPage(touchGesture.centerX, touchGesture.centerY);
    const factor = next.distance / touchGesture.distance;
    const min = minScale();
    view.scale = Math.min(
      Math.max(view.scale * factor, min),
      min * MAX_ZOOM_FACTOR
    );
    view.panX = next.centerX - before.x * view.scale;
    view.panY = next.centerY - before.y * view.scale;
    touchGesture = next;
    clampView();
    scheduleDraw();
    updateLiveInkOverlayStyle();
  }

  function continueAfterTouchGesture() {
    touchGesture = null;
    if (touchPointers.size >= 2) {
      touchGesture = currentTouchGesture();
      return;
    }
    if (touchPointers.size === 1) {
      const entry = touchPointers.entries().next().value;
      if (!entry) {
        resetPointer();
        updateLiveInkOverlayStyle();
        return;
      }
      const [id, pointer] = entry;
      pointerMode = 'pan';
      activePointerId = id;
      lastPointer = { x: pointer.clientX, y: pointer.clientY };
      updateLiveInkOverlayStyle();
      return;
    }
    resetPointer();
    updateLiveInkOverlayStyle();
  }

  function handleTouchPointerDown(event: PointerEvent) {
    if (!doc || !canvasEl) return;
    event.preventDefault();
    canvasEl.focus({ preventScroll: true });
    canvasEl.setPointerCapture(event.pointerId);
    touchPointers.set(event.pointerId, touchPointer(event));
    if (touchPointers.size >= 2) {
      beginTouchGesture();
      return;
    }
    activePointerId = event.pointerId;
    if (!fingerDrawingAllowed) {
      pointerMode = 'pan';
      lastPointer = { x: event.clientX, y: event.clientY };
      return;
    }
    if (isTrashed) return;
    const handle = selectionHandleAtCanvasPoint(
      canvasPoint(event.clientX, event.clientY)
    );
    if (tool === 'lasso' && hasSelection && handle) {
      beginSelectionTransform(handle, event);
      return;
    }
    if (
      tool === 'lasso' &&
      hasSelection &&
      selectionContainsPoint(eventPoint(event))
    ) {
      beginSelectionMove(event);
      return;
    }
    if (tool === 'lasso') {
      beginLasso(event);
      return;
    }
    if (tool === 'eraser') {
      pointerMode = 'erase';
      selectedStrokeIds = [];
      selectionFrame = null;
      eraserHits.clear();
      eraseFromEvent(event);
      return;
    }
    pointerMode = 'draw';
    inFlight = [];
    drawingStrokeActive = false;
    pushPointerSamples(event);
  }

  function handleTouchPointerMove(event: PointerEvent) {
    if (!touchPointers.has(event.pointerId)) return;
    event.preventDefault();
    touchPointers.set(event.pointerId, touchPointer(event));
    if (pointerMode === 'touchGesture' || touchPointers.size >= 2) {
      if (pointerMode !== 'touchGesture') {
        beginTouchGesture();
      }
      updateTouchGesture();
      return;
    }
    handleActivePointerMove(event);
  }

  function handleTouchPointerEnd(event: PointerEvent, cancelled = false) {
    const hadPointer = touchPointers.delete(event.pointerId);
    if (!hadPointer) return;
    event.preventDefault();
    if (pointerMode === 'touchGesture') {
      continueAfterTouchGesture();
      return;
    }
    handleActivePointerEnd(event, cancelled);
  }

  function handlePointerEnter(event: PointerEvent) {
    updateToolPreview(event);
  }

  function handlePointerLeave(event: PointerEvent) {
    if (activePointerId === null || activePointerId === event.pointerId) {
      clearToolPreview();
    }
  }

  function handlePointerDown(event: PointerEvent) {
    if (!doc || !canvasEl) return;
    if (event.pointerType === 'touch') {
      handleTouchPointerDown(event);
      return;
    }
    event.preventDefault();
    canvasEl.focus({ preventScroll: true });
    canvasEl.setPointerCapture(event.pointerId);
    activePointerId = event.pointerId;
    const isFinger = event.pointerType === 'touch';
    const shouldPan =
      event.button === 1 ||
      event.buttons === 4 ||
      (isFinger && !fingerDrawingAllowed);
    if (shouldPan) {
      pointerMode = 'pan';
      lastPointer = { x: event.clientX, y: event.clientY };
      return;
    }
    if (isTrashed) return;
    const handle = selectionHandleAtCanvasPoint(
      canvasPoint(event.clientX, event.clientY)
    );
    if (tool === 'lasso' && hasSelection && handle) {
      beginSelectionTransform(handle, event);
      return;
    }
    if (
      tool === 'lasso' &&
      hasSelection &&
      selectionContainsPoint(eventPoint(event))
    ) {
      beginSelectionMove(event);
      return;
    }
    if (tool === 'lasso') {
      beginLasso(event);
      return;
    }
    if (tool === 'eraser' || isStylusButtonErasing(event)) {
      pointerMode = 'erase';
      selectedStrokeIds = [];
      selectionFrame = null;
      eraserHits.clear();
      updateToolPreview(event);
      eraseFromEvent(event);
      return;
    }
    pointerMode = 'draw';
    inFlight = [];
    drawingStrokeActive = false;
    pushPointerSamples(event);
  }

  function handlePointerMove(event: PointerEvent) {
    if (event.pointerType === 'touch') {
      handleTouchPointerMove(event);
      return;
    }
    updateToolPreview(event);
    handleActivePointerMove(event);
  }

  function handleActivePointerMove(event: PointerEvent) {
    if (activePointerId !== event.pointerId) return;
    if (pointerMode === 'pan') {
      event.preventDefault();
      const current = { x: event.clientX, y: event.clientY };
      if (lastPointer) {
        view.panX += current.x - lastPointer.x;
        view.panY += current.y - lastPointer.y;
        clampView();
        scheduleDraw();
      }
      lastPointer = current;
      return;
    }
    if (pointerMode === 'erase') {
      event.preventDefault();
      updateToolPreview(event);
      eraseFromEvent(event);
      return;
    }
    if (pointerMode === 'lasso') {
      event.preventDefault();
      pushLassoSamples(event);
      return;
    }
    if (pointerMode === 'moveSelection') {
      event.preventDefault();
      updateSelectionMove(event);
      return;
    }
    if (pointerMode === 'draw') {
      event.preventDefault();
      if (isStylusButtonErasing(event)) {
        finishActiveStroke();
        pointerMode = 'erase';
        selectedStrokeIds = [];
        selectionFrame = null;
        eraserHits.clear();
        updateToolPreview(event);
        eraseFromEvent(event);
        return;
      }
      pushPointerSamples(event);
    }
  }

  function handlePointerUp(event: PointerEvent) {
    if (event.pointerType === 'touch') {
      handleTouchPointerEnd(event);
      return;
    }
    handleActivePointerEnd(event);
  }

  function handleActivePointerEnd(event: PointerEvent, cancelled = false) {
    if (activePointerId !== event.pointerId) return;
    event.preventDefault();
    if (cancelled) {
      if (pointerMode === 'erase' && doc) {
        flushQueuedEraserSamples();
        doc.finishEraserDrag(eraserHits);
        syncHistoryState();
      } else if (pointerMode === 'lasso') {
        lassoPoints = [];
        selectedStrokeIds = [];
        selectionFrame = null;
      } else if (pointerMode === 'moveSelection') {
        cancelSelectionMove();
      } else {
        clearQueuedEraserSamples();
      }
      cancelActiveStroke();
      inFlight = [];
      resetPointer();
      scheduleDraw();
      return;
    }
    if (pointerMode === 'draw' && doc) {
      if (!isStylusButtonErasing(event)) {
        pushPointerSamples(event);
      }
      finishActiveStroke();
    } else if (pointerMode === 'erase' && doc) {
      flushQueuedEraserSamples();
      doc.finishEraserDrag(eraserHits);
      syncHistoryState();
    } else if (pointerMode === 'lasso') {
      finishLasso();
    } else if (pointerMode === 'moveSelection') {
      finishSelectionMove();
    }
    resetPointer();
  }

  function handlePointerCancel(event: PointerEvent) {
    if (event.pointerType === 'touch') {
      handleTouchPointerEnd(event, true);
      return;
    }
    handleActivePointerEnd(event, true);
  }

  function pushPointerSamples(event: PointerEvent) {
    if (!doc) return;
    if (isStylusButtonErasing(event)) return;
    selectedStrokeIds = [];
    selectionFrame = null;
    const next = [...inFlight];
    for (const sample of pointerSamples(event)) {
      const point = eventPoint(sample);
      if (!containsPagePoint(layout, point.x, point.y)) {
        if (drawingStrokeActive) {
          inFlight = next;
          finishActiveStroke();
          next.length = 0;
        }
        continue;
      }
      if (!drawingStrokeActive) {
        doc.beginStroke(colorArgb, width);
        drawingStrokeActive = true;
      }
      const last = next[next.length - 1];
      if (last && Math.hypot(point.x - last.x, point.y - last.y) < 1.5) {
        continue;
      }
      doc.pushPoint(point.x, point.y, point.pressure);
      next.push(point);
    }
    inFlight = next;
  }

  function beginLasso(event: PointerEvent) {
    pointerMode = 'lasso';
    selectedStrokeIds = [];
    selectionFrame = null;
    lassoPoints = [];
    pushLassoSamples(event);
  }

  function pushLassoSamples(event: PointerEvent) {
    const next = [...lassoPoints];
    for (const sample of pointerSamples(event)) {
      const point = eventPoint(sample);
      const last = next[next.length - 1];
      if (last && Math.hypot(point.x - last.x, point.y - last.y) < 6) {
        continue;
      }
      next.push(point);
    }
    lassoPoints = next;
    scheduleDraw();
  }

  function finishLasso() {
    if (!doc || lassoPoints.length < 3) {
      lassoPoints = [];
      scheduleDraw();
      return;
    }
    selectedStrokeIds = doc.strokeIdsInLasso(lassoPoints);
    selectionFrame =
      selectedStrokeIds.length > 0
        ? (() => {
            const bounds = selectionBounds();
            return bounds ? frameFromBounds(bounds) : null;
          })()
        : null;
    lassoPoints = [];
    scheduleDraw();
  }

  function beginSelectionMove(event: PointerEvent) {
    pointerMode = 'moveSelection';
    selectionDragStart = eventPoint(event);
    selectionInteraction = { kind: 'move', start: selectionDragStart };
    selectionDragOffset = { x: 0, y: 0 };
    selectionTransformPreview = identityTransform();
    lassoPoints = [];
  }

  function beginSelectionTransform(
    handle: SelectionHandle,
    event: PointerEvent
  ) {
    const frame = baseSelectionFrame();
    if (!frame) return;
    pointerMode = 'moveSelection';
    selectionDragStart = eventPoint(event);
    selectionDragOffset = { x: 0, y: 0 };
    selectionTransformPreview = identityTransform();
    lassoPoints = [];
    if (handle === 'rotate') {
      const center = selectionCenter(frame);
      const point = eventPoint(event);
      selectionInteraction = {
        kind: 'rotate',
        center,
        startAngle: Math.atan2(point.y - center.y, point.x - center.x)
      };
      return;
    }
    const opposite: Record<
      Exclude<SelectionHandle, 'rotate'>,
      Exclude<SelectionHandle, 'rotate'>
    > = {
      nw: 'se',
      ne: 'sw',
      se: 'nw',
      sw: 'ne'
    };
    selectionInteraction = {
      kind: 'resize',
      handle,
      anchor: frame[opposite[handle]],
      startCorner: frame[handle]
    };
  }

  function updateSelectionMove(event: PointerEvent) {
    if (!selectionInteraction) return;
    const point = eventPoint(event);
    if (selectionInteraction.kind === 'move') {
      selectionDragOffset = {
        x: point.x - selectionInteraction.start.x,
        y: point.y - selectionInteraction.start.y
      };
      selectionTransformPreview = identityTransform();
    } else if (selectionInteraction.kind === 'resize') {
      selectionDragOffset = { x: 0, y: 0 };
      selectionTransformPreview = resizeTransform(
        selectionInteraction.anchor,
        selectionInteraction.startCorner,
        point
      );
    } else {
      selectionDragOffset = { x: 0, y: 0 };
      const delta =
        Math.atan2(
          point.y - selectionInteraction.center.y,
          point.x - selectionInteraction.center.x
        ) - selectionInteraction.startAngle;
      selectionTransformPreview = rotationTransform(
        selectionInteraction.center,
        delta
      );
    }
    scheduleDraw();
  }

  function cancelSelectionMove() {
    selectionDragStart = null;
    selectionInteraction = null;
    selectionDragOffset = { x: 0, y: 0 };
    selectionTransformPreview = identityTransform();
    scheduleDraw();
  }

  function finishSelectionMove() {
    if (!doc || !selectionInteraction) {
      cancelSelectionMove();
      return;
    }
    const interaction = selectionInteraction;
    const frame = baseSelectionFrame();
    const move = selectionDragOffset;
    const transform = currentSelectionTransform();
    selectionDragStart = null;
    selectionInteraction = null;
    selectionDragOffset = { x: 0, y: 0 };
    selectionTransformPreview = identityTransform();
    if (interaction.kind === 'move') {
      if (Math.abs(move.x) < 0.001 && Math.abs(move.y) < 0.001) {
        scheduleDraw();
        return;
      }
      const { value, update } = doc.translateStrokes(
        selectedStrokeIds,
        move.x,
        move.y
      );
      if (value.length > 0) {
        selectedStrokeIds = value;
        if (frame) {
          selectionFrame = transformSelectionFrame(
            frame,
            translationTransform(move.x, move.y)
          );
        }
        applyDocumentMutation(update);
      } else {
        scheduleDraw();
      }
      return;
    }
    if (transformIsIdentity(transform)) {
      scheduleDraw();
      return;
    }
    const { value, update } = doc.transformStrokes(
      selectedStrokeIds,
      transform
    );
    if (value.length > 0) {
      selectedStrokeIds = value;
      if (frame) {
        selectionFrame = transformSelectionFrame(frame, transform);
      }
      applyDocumentMutation(update);
    } else {
      scheduleDraw();
    }
  }

  function eraseAtPoint(point: InkPoint, hits: Set<string>) {
    if (!containsPagePoint(layout, point.x, point.y)) return;
    queuedEraserSamples.push({ point, hits });
    if (eraserFrame !== null) return;
    eraserFrame = requestAnimationFrame(() => flushQueuedEraserSamples());
  }

  function eraseFromEvent(event: PointerEvent) {
    for (const sample of pointerSamples(event)) {
      const point = eventPoint(sample);
      eraseAtPoint(point, eraserHits);
    }
  }

  function handleAndroidStylusEraser(event: Event) {
    if (!doc || !canvasEl || isTrashed) return;
    const detail = (event as CustomEvent<AndroidStylusEraserPayload>).detail;
    if (!detail || !Array.isArray(detail.points)) return;

    if (pointerMode === 'draw') {
      finishActiveStroke();
      releaseActivePointerCapture();
      resetPointer();
    }
    if (detail.action === 'down' || !androidStylusEraserActive) {
      androidStylusEraserHits.clear();
      androidStylusEraserActive = true;
    }

    for (const sample of detail.points) {
      if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y)) continue;
      const point = clientPoint(sample.x, sample.y, sample.pressure ?? 1);
      eraseAtPoint(point, androidStylusEraserHits);
    }

    if (detail.action === 'up' || detail.action === 'cancel') {
      flushQueuedEraserSamples();
      doc.finishEraserDrag(androidStylusEraserHits);
      syncHistoryState();
      androidStylusEraserHits.clear();
      androidStylusEraserActive = false;
      if (pointerMode === 'erase') {
        releaseActivePointerCapture();
        resetPointer();
      }
    }
  }

  function flushQueuedEraserSamples() {
    if (eraserFrame !== null) {
      cancelAnimationFrame(eraserFrame);
      eraserFrame = null;
    }
    if (!doc || queuedEraserSamples.length === 0) {
      queuedEraserSamples = [];
      return;
    }

    const grouped = new Map<Set<string>, InkPoint[]>();
    for (const sample of queuedEraserSamples) {
      const group = grouped.get(sample.hits);
      if (group) {
        group.push(sample.point);
      } else {
        grouped.set(sample.hits, [sample.point]);
      }
    }
    queuedEraserSamples = [];

    const updates: Uint8Array[] = [];
    let erasedAny = false;
    for (const [hits, points] of grouped) {
      const { value: erased, update } = doc.eraseAtMany(
        points,
        ERASER_RADIUS,
        hits
      );
      if (erased.length === 0) continue;
      erasedAny = true;
      for (const id of erased) {
        hits.add(id);
      }
      if (update) {
        updates.push(update);
      }
    }

    if (erasedAny) {
      applyDocumentMutations(updates);
    }
  }

  function clearQueuedEraserSamples() {
    if (eraserFrame !== null) {
      cancelAnimationFrame(eraserFrame);
      eraserFrame = null;
    }
    queuedEraserSamples = [];
  }

  function resetPointer() {
    pointerMode = null;
    activePointerId = null;
    lastPointer = null;
    touchGesture = null;
    drawingStrokeActive = false;
  }

  function releaseActivePointerCapture() {
    if (!canvasEl || activePointerId === null) return;
    try {
      if (canvasEl.hasPointerCapture(activePointerId)) {
        canvasEl.releasePointerCapture(activePointerId);
      }
    } catch {
      // Pointer capture may already have been released by the browser.
    }
  }

  function finishActiveStroke() {
    if (!doc || !drawingStrokeActive) {
      inFlight = [];
      return;
    }
    const { value, update } = doc.endStroke();
    drawingStrokeActive = false;
    inFlight = [];
    if (value) {
      applyDocumentMutation(update);
      if (isAndroid()) {
        void drawingCancelLiveInk();
      }
    } else {
      syncHistoryState();
      scheduleDraw();
    }
  }

  function cancelActiveStroke() {
    doc?.cancelStroke();
    drawingStrokeActive = false;
    if (isAndroid()) {
      void drawingCancelLiveInk();
    }
  }

  function handleWheel(event: WheelEvent) {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-event.deltaY * 0.001);
      zoomAround(event.offsetX, event.offsetY, factor);
      zoomUiVersion += 1;
    } else if (event.shiftKey) {
      view.panX -= event.deltaY + event.deltaX;
    } else {
      view.panX -= event.deltaX;
      view.panY -= event.deltaY;
    }
    clampView();
    scheduleDraw();
    updateLiveInkOverlayStyle();
  }

  function zoomAround(screenX: number, screenY: number, factor: number) {
    const before = screenToPage(screenX, screenY);
    const min = minScale();
    view.scale = Math.min(
      Math.max(view.scale * factor, min),
      min * MAX_ZOOM_FACTOR
    );
    view.panX = screenX - before.x * view.scale;
    view.panY = screenY - before.y * view.scale;
  }

  function setInkZoom(value: number) {
    const centerX = view.width * 0.5;
    const centerY = view.height * 0.5;
    const before = screenToPage(centerX, centerY);
    const min = minScale();
    view.scale = Math.min(Math.max(value, min), min * MAX_ZOOM_FACTOR);
    view.panX = centerX - before.x * view.scale;
    view.panY = centerY - before.y * view.scale;
    clampView();
    scheduleDraw();
    updateLiveInkOverlayStyle();
    zoomMenuOpen = false;
    zoomUiVersion += 1;
  }

  function setInkDisplayZoom(value: number) {
    setInkZoom(scaleFromDisplayInkZoom(value));
  }

  function setFitWidthZoom() {
    fitWidth();
    scheduleDraw();
    updateLiveInkOverlayStyle();
    zoomMenuOpen = false;
    zoomUiVersion += 1;
  }

  function zoomInkBy(factor: number) {
    setInkZoom(view.scale * factor);
  }

  function selectedClipboardStrokes(): InkClipboardStroke[] {
    if (!doc || selectedStrokeIds.length === 0) return [];
    const selected = new Set(selectedStrokeIds);
    return doc
      .visibleStrokes()
      .filter((stroke) => selected.has(stroke.id))
      .map((stroke) => ({
        color: stroke.color,
        width: stroke.width,
        points: stroke.points.map((point) => ({ ...point }))
      }));
  }

  function copySelection(): boolean {
    const strokes = selectedClipboardStrokes();
    if (strokes.length === 0) return false;
    selectionClipboard = strokes;
    return true;
  }

  function cutSelection(): boolean {
    if (!copySelection()) return false;
    return deleteSelection();
  }

  function pasteSelection(): boolean {
    if (!doc || isTrashed || selectionClipboard.length === 0) return false;
    flushQueuedEraserSamples();
    const offset = SELECTION_PASTE_OFFSET_PX / Math.max(0.001, view.scale);
    const pasted = selectionClipboard.map((stroke) => ({
      color: stroke.color,
      width: stroke.width,
      points: stroke.points.map((point) => ({
        x: point.x + offset,
        y: point.y + offset,
        pressure: point.pressure
      }))
    }));
    const { value, update } = doc.addStrokes(pasted);
    if (value.length === 0) return false;
    selectionClipboard = pasted.map((stroke) => ({
      color: stroke.color,
      width: stroke.width,
      points: stroke.points.map((point) => ({ ...point }))
    }));
    tool = 'lasso';
    selectedStrokeIds = value;
    selectionFrame = (() => {
      const bounds = selectionBounds();
      return bounds ? frameFromBounds(bounds) : null;
    })();
    lassoPoints = [];
    selectionInteraction = null;
    selectionDragStart = null;
    selectionDragOffset = { x: 0, y: 0 };
    selectionTransformPreview = identityTransform();
    applyDocumentMutation(update);
    emitToolbarSettings();
    return true;
  }

  function applySelectionStyle(patch: StrokeStylePatch): boolean {
    if (!doc || isTrashed || selectedStrokeIds.length === 0) return false;
    flushQueuedEraserSamples();
    const { value, update } = doc.styleStrokes(selectedStrokeIds, patch);
    if (value.length === 0) {
      scheduleDraw();
      return false;
    }
    selectedStrokeIds = value;
    applyDocumentMutation(update);
    return true;
  }

  function minScale(): number {
    const availableWidth = Math.max(1, view.width - PAGE_FIT_MARGIN * 2);
    const availableHeight = Math.max(
      1,
      view.height - PAGE_FIT_TOP_MARGIN - PAGE_FIT_MARGIN
    );
    return Math.max(
      0.05,
      Math.min(
        availableWidth / layout.page.width,
        availableHeight / layout.page.height
      )
    );
  }

  function setTool(next: ToolMode) {
    tool = next;
    lassoPoints = [];
    selectionInteraction = null;
    selectionDragStart = null;
    selectionDragOffset = { x: 0, y: 0 };
    selectionTransformPreview = identityTransform();
    clearToolPreview();
    emitToolbarSettings();
    updateLiveInkOverlayStyle();
  }

  function setColor(value: string) {
    const normalized = normalizeColorHex(value);
    if (!normalized) return;
    colorInputText = normalized;
    const next = colorHexToArgb(normalized);
    colorArgb = next;
    if (hasSelection) applySelectionStyle({ color: next });
    scheduleDraw();
    emitToolbarSettings();
    updateLiveInkOverlayStyle();
  }

  function setColorInputText(value: string) {
    colorInputText = value;
    const normalized = normalizeColorHex(value);
    if (normalized) setColor(normalized);
  }

  function selectPresetColor(value: string) {
    setColor(value);
    toolbarMenuOpen = null;
  }

  function toggleToolbarMenu(menu: 'style' | 'selection' | 'settings') {
    toolbarMenuOpen = toolbarMenuOpen === menu ? null : menu;
  }

  function setWidth(value: string) {
    const next = normalizeInkWidth(Number(value));
    width = next;
    if (hasSelection) applySelectionStyle({ width: next });
    scheduleDraw();
    emitToolbarSettings();
    updateLiveInkOverlayStyle();
  }

  function toggleFingerDrawing() {
    fingerDrawingAllowed = !fingerDrawingAllowed;
    emitToolbarSettings();
    updateLiveInkOverlayStyle();
  }

  // Cycle Light → Dark → Follow app theme → Light, matching the
  // three-way choice offered by the settings dialog's select.
  function cyclePageTheme() {
    pageThemeMode =
      pageThemeMode === 'light'
        ? 'dark'
        : pageThemeMode === 'dark'
          ? 'system'
          : 'light';
    emitToolbarSettings();
  }

  function undo() {
    if (!doc) return;
    flushQueuedEraserSamples();
    selectedStrokeIds = [];
    selectionFrame = null;
    lassoPoints = [];
    selectionInteraction = null;
    selectionDragStart = null;
    selectionDragOffset = { x: 0, y: 0 };
    selectionTransformPreview = identityTransform();
    const { value, update } = doc.undoLast();
    if (value) applyDocumentMutation(update);
  }

  function redo() {
    if (!doc) return;
    flushQueuedEraserSamples();
    selectedStrokeIds = [];
    selectionFrame = null;
    lassoPoints = [];
    selectionInteraction = null;
    selectionDragStart = null;
    selectionDragOffset = { x: 0, y: 0 };
    selectionTransformPreview = identityTransform();
    const { value, update } = doc.redoLast();
    if (value) applyDocumentMutation(update);
  }

  function deleteSelection(): boolean {
    if (!doc || isTrashed || selectedStrokeIds.length === 0) return false;
    flushQueuedEraserSamples();
    const { value, update } = doc.deleteStrokes(selectedStrokeIds);
    selectedStrokeIds = [];
    selectionFrame = null;
    lassoPoints = [];
    selectionInteraction = null;
    selectionDragStart = null;
    selectionDragOffset = { x: 0, y: 0 };
    selectionTransformPreview = identityTransform();
    if (value.length > 0) {
      applyDocumentMutation(update);
      return true;
    }
    scheduleDraw();
    return false;
  }

  function clearCanvas() {
    if (!doc) return;
    flushQueuedEraserSamples();
    selectedStrokeIds = [];
    selectionFrame = null;
    lassoPoints = [];
    selectionInteraction = null;
    selectionDragStart = null;
    selectionDragOffset = { x: 0, y: 0 };
    selectionTransformPreview = identityTransform();
    const { value, update } = doc.clearAll();
    if (value.length > 0) applyDocumentMutation(update);
  }

  async function confirmClearCanvas() {
    if (!doc || isTrashed || strokeCount === 0) return;
    const ok = await confirm({
      title: tUi('ink.toolbar.clearConfirm.title'),
      message: tUi('ink.toolbar.clearConfirm.message'),
      confirmLabel: tUi('ink.toolbar.clearConfirm.button'),
      destructive: true
    });
    if (ok) clearCanvas();
  }

  function isEditableShortcutTarget(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    );
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (isEditableShortcutTarget(event.target)) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && !event.shiftKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 'c' && hasSelection && copySelection()) {
        event.preventDefault();
        return;
      }
      if (key === 'x' && hasSelection && cutSelection()) {
        event.preventDefault();
        return;
      }
      if (key === 'v' && hasSelectionClipboard && pasteSelection()) {
        event.preventDefault();
        return;
      }
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (hasSelection && deleteSelection()) {
        event.preventDefault();
      }
    }
  }

  $effect(() => {
    if (!toolbarMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (styleMenuEl?.contains(target)) return;
      if (styleMenuButton?.contains(target)) return;
      if (selectionMenuEl?.contains(target)) return;
      if (selectionMenuButton?.contains(target)) return;
      if (settingsMenuEl?.contains(target)) return;
      if (settingsMenuButton?.contains(target)) return;
      toolbarMenuOpen = null;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') toolbarMenuOpen = null;
    };
    queueMicrotask(() => window.addEventListener('pointerdown', onPointerDown));
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  });

  function handleInkCommand(id: string): boolean {
    switch (id) {
      case 'editor.ink.pen':
        setTool('pen');
        return true;
      case 'editor.ink.eraser':
        setTool('eraser');
        return true;
      case 'editor.ink.lasso':
        setTool('lasso');
        return true;
      case 'editor.ink.undo':
        undo();
        return true;
      case 'editor.ink.redo':
        redo();
        return true;
      case 'editor.ink.toggleFingerDrawing':
        toggleFingerDrawing();
        return true;
      case 'editor.ink.togglePageTheme':
        cyclePageTheme();
        return true;
      case 'editor.ink.clear':
        if (!isTrashed) void confirmClearCanvas();
        return true;
      default:
        console.warn('[InkWebNoteEditor] unknown ink command', id);
        return false;
    }
  }

  function normalizeInkTool(value: unknown): ToolMode {
    if (value === 'eraser' || value === 'lasso') return value;
    return 'pen';
  }

  function normalizeInkPageTheme(value: unknown): PageThemeMode {
    if (value === 'system') return 'system';
    if (value === 'dark') return 'dark';
    return 'light';
  }

  function normalizeInkWidth(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? Math.min(12, Math.max(0.5, n)) : DEFAULT_WIDTH;
  }

  function normalizeColorHex(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    const hex = raw.startsWith('#') ? raw.slice(1) : raw;
    if (/^[0-9a-fA-F]{3}$/.test(hex)) {
      return `#${hex
        .split('')
        .map((c) => c + c)
        .join('')
        .toLowerCase()}`;
    }
    if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex.toLowerCase()}`;
    return null;
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

  function displayCssColor(argb: number): string {
    return cssColor(displayColor(argb));
  }

  function cssColor(argb: number): string {
    const key = argb >>> 0;
    const cached = cssColorCache.get(key);
    if (cached) return cached;
    const a = ((argb >>> 24) & 0xff) / 255;
    const r = (argb >>> 16) & 0xff;
    const g = (argb >>> 8) & 0xff;
    const b = argb & 0xff;
    const value = `rgba(${r}, ${g}, ${b}, ${a})`;
    cssColorCache.set(key, value);
    return value;
  }

  // Mirrors Excalidraw's dark-mode color transform: the CSS filter
  // `invert(93%) hue-rotate(180deg)` applied mathematically per ARGB,
  // so red stays red and blue stays blue but lightness is flipped.
  // invert(93%) gives R' = 0.93 - 0.86·R; the 180° hue rotation uses
  // the YIQ-like matrix from the CSS filter-effects spec, which (at
  // θ=180°) reduces to row sums of 1, so greys round-trip cleanly.
  function displayColor(argb: number): number {
    if (!pageDark) return argb >>> 0;
    const alpha = argb & 0xff000000;
    const ir = 0.93 - 0.86 * (((argb >>> 16) & 0xff) / 255);
    const ig = 0.93 - 0.86 * (((argb >>> 8) & 0xff) / 255);
    const ib = 0.93 - 0.86 * ((argb & 0xff) / 255);
    const r = clampUnit(-0.574 * ir + 1.43 * ig + 0.144 * ib);
    const g = clampUnit(0.426 * ir + 0.43 * ig + 0.144 * ib);
    const b = clampUnit(0.426 * ir + 1.43 * ig - 0.856 * ib);
    const R = Math.round(r * 255);
    const G = Math.round(g * 255);
    const B = Math.round(b * 255);
    return (alpha | (R << 16) | (G << 8) | B) >>> 0;
  }

  function clampUnit(value: number): number {
    return value < 0 ? 0 : value > 1 ? 1 : value;
  }

  function sanitizePressure(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 1;
    return Math.min(1, value);
  }

  function base64ToBytes(b64: string): Uint8Array {
    const standard = b64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  onMount(async () => {
    const mountStartedAt = performance.now();
    const mobile = isMobile();
    mobileToolbar = mobile;
    if (isTauri() && mobile) {
      void acquireFullscreen();
      fullscreenAcquired = true;
    }
    if (isAndroid()) {
      void drawingEnterImmersiveInkMode();
      immersiveInkModeActive = true;
    }
    window.addEventListener(
      'mindstream:android-stylus-eraser',
      handleAndroidStylusEraser
    );
    await tick();
    if (hostEl) {
      editorListener = {
        kind: 'ink',
        host: hostEl,
        onCommand: handleInkCommand
      };
      registerEditor(editorListener);
    }
    const afterTickAt = performance.now();
    if (isAndroid()) {
      // Push the initial bounds BEFORE showing the overlay so Kotlin
      // already knows the document + control regions the moment the
      // SurfaceView starts receiving MotionEvents. Document bounds
      // start empty (Kotlin treats empty as "block all"), keeping the
      // overlay inert until the post-loadNote re-push lands the real
      // page rects below.
      await drawingSetDocumentBounds(collectDocumentBounds());
      await drawingSetControlBounds(collectControlBounds());
      await drawingShowLiveInkOverlay();
    }
    const liveOverlayReadyAt = performance.now();
    const note = await loadNote(noteId);
    if (disposed) return;
    const noteLoadedAt = performance.now();
    doc = InkDocument.fromBytes(new Uint8Array(note.yrs_state));
    const decodedAt = performance.now();
    handle = {
      encode_state_vector: () => doc?.encodeStateVector() ?? new Uint8Array(),
      encode_diff_for_state_vector: (stateVector) =>
        doc?.encodeDiffForStateVector(stateVector) ?? new Uint8Array(),
      apply_remote_update: (update) => {
        const applied = doc?.applyRemoteUpdate(update) ?? false;
        if (applied) {
          refreshFromDoc();
          queueSaveUpdates([update]);
        }
        return applied;
      }
    };
    const settings = currentToolbarSettings();
    tool = normalizeInkTool(settings.tool);
    colorArgb = settings.colorArgb ?? DEFAULT_COLOR;
    width = settings.width ?? DEFAULT_WIDTH;
    fingerDrawingAllowed = settings.fingerDrawingAllowed ?? true;
    pageThemeMode = settings.pageThemeMode ?? 'light';
    refreshFromDoc();
    resizeCanvas();
    updateLiveInkOverlayStyle();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve())
    );
    if (disposed) return;
    console.info(
      '[ink.perf] web_open note=%s tick_ms=%d live_overlay_ms=%d load_note_ms=%d decode_ms=%d first_draw_ms=%d state_bytes=%d strokes=%d pages=%d android=%s',
      noteId,
      Math.round(afterTickAt - mountStartedAt),
      Math.round(liveOverlayReadyAt - afterTickAt),
      Math.round(noteLoadedAt - liveOverlayReadyAt),
      Math.round(decodedAt - noteLoadedAt),
      Math.round(performance.now() - mountStartedAt),
      note.yrs_state.length,
      strokeCount,
      layout.pageCount,
      isAndroid()
    );
    resizeObserver = new ResizeObserver(() => {
      resizeCanvas();
      scheduleBoundsPush();
    });
    if (canvasHostEl) resizeObserver.observe(canvasHostEl);
    if (toolbarEl) resizeObserver.observe(toolbarEl);
    // visualViewport tracks IME show/hide and orientation in the way
    // the standard window `resize` event misses on mobile Chromium —
    // keep both wired up so a software keyboard popping over the
    // toolbar or a rotation reshapes the no-paint region promptly.
    window.addEventListener('resize', scheduleBoundsPush);
    window.visualViewport?.addEventListener('resize', scheduleBoundsPush);
    window.visualViewport?.addEventListener('scroll', scheduleBoundsPush);
    toolbarSettingsReady = true;
    lastSeenPushed = tree.notesById[noteId]?.pushed ?? false;
    await setupCollabProvider();
    collabReady = true;
    unsubSession = onSessionChange(() => {
      void setupCollabProvider();
    });
  });

  $effect(() => {
    if (!hostEl || !editorListener) return;
    const host = hostEl;
    const listener = editorListener;
    const promote = () => registerEditor(listener);
    host.addEventListener('focusin', promote);
    host.addEventListener('pointerdown', promote);
    return () => {
      host.removeEventListener('focusin', promote);
      host.removeEventListener('pointerdown', promote);
    };
  });

  $effect(() => {
    if (!hostEl) return;
    const host = hostEl;
    const onKeyDown = (event: KeyboardEvent) => {
      const active = document.activeElement;
      if (!active || !host.contains(active)) return;
      handleKeyDown(event);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  onDestroy(() => {
    window.removeEventListener(
      'mindstream:android-stylus-eraser',
      handleAndroidStylusEraser
    );
    window.removeEventListener('resize', scheduleBoundsPush);
    window.visualViewport?.removeEventListener('resize', scheduleBoundsPush);
    window.visualViewport?.removeEventListener('scroll', scheduleBoundsPush);
    if (boundsFrame !== null) {
      cancelAnimationFrame(boundsFrame);
      boundsFrame = null;
    }
    flushQueuedEraserSamples();
    clearSaveTimer();
    void flushPendingState();
    if (editorListener) {
      unregisterEditor(editorListener);
      editorListener = null;
    }
    if (drawFrame !== null) {
      cancelAnimationFrame(drawFrame);
      drawFrame = null;
    }
    if (resizeSnapshotHideTimer !== null) {
      clearTimeout(resizeSnapshotHideTimer);
      resizeSnapshotHideTimer = null;
    }
    if (isAndroid()) {
      // hideLiveInkOverlay resets bounds + offset on the Kotlin side,
      // but push an explicit clear too in case the overlay was already
      // hidden — keeps the next show from inheriting stale bounds.
      void drawingSetDocumentBounds([]);
      void drawingSetControlBounds([]);
      void drawingHideLiveInkOverlay();
    }
    if (immersiveInkModeActive) {
      void drawingExitImmersiveInkMode();
      immersiveInkModeActive = false;
    }
    if (fullscreenAcquired) {
      void releaseFullscreen();
      fullscreenAcquired = false;
    }
    disposed = true;
    collabReady = false;
    unsubSession?.();
    unsubSession = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    provider?.destroy();
    provider = null;
    collabConfigured = false;
    collabOnline = false;
    clearNoteStatus(noteId);
    doc = null;
    handle = null;
  });
</script>

{#snippet selectionActionsExpanded()}
  <ToolbarButton
    aria-label={tUi('ink.toolbar.cutSelected')}
    title={tUi('ink.toolbar.cutSelected')}
    disabled={isTrashed || !hasSelection}
    onclick={cutSelection}
  >
    <Scissors aria-hidden="true" />
  </ToolbarButton>
  <ToolbarButton
    aria-label={tUi('ink.toolbar.copySelected')}
    title={tUi('ink.toolbar.copySelected')}
    disabled={!hasSelection}
    onclick={copySelection}
  >
    <Copy aria-hidden="true" />
  </ToolbarButton>
  <ToolbarButton
    aria-label={tUi('ink.toolbar.pasteInk')}
    title={tUi('ink.toolbar.pasteInk')}
    disabled={isTrashed || !hasSelectionClipboard}
    onclick={pasteSelection}
  >
    <ClipboardPaste aria-hidden="true" />
  </ToolbarButton>
  <ToolbarButton
    aria-label={tUi('ink.toolbar.deleteSelected')}
    title={tUi('ink.toolbar.deleteSelected')}
    disabled={isTrashed || !hasSelection}
    onclick={deleteSelection}
  >
    <Trash2 aria-hidden="true" />
  </ToolbarButton>
{/snippet}

{#snippet selectionActionsCollapsed()}
  <div class="relative shrink-0">
    <ToolbarButton
      bind:ref={selectionMenuButton}
      active={toolbarMenuOpen === 'selection'}
      aria-label={tUi('ink.toolbar.selectionActions')}
      title={tUi('ink.toolbar.selectionActions')}
      aria-haspopup="menu"
      aria-expanded={toolbarMenuOpen === 'selection'}
      onclick={() => toggleToolbarMenu('selection')}
    >
      <PocketKnife aria-hidden="true" />
    </ToolbarButton>

    {#if toolbarMenuOpen === 'selection'}
      <div
        bind:this={selectionMenuEl}
        role="menu"
        class="absolute left-0 top-full z-50 mt-1 min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        aria-label={tUi('ink.toolbar.selectionActions')}
      >
        <button
          type="button"
          role="menuitem"
          class="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          disabled={isTrashed || !hasSelection}
          onclick={() => {
            if (cutSelection()) toolbarMenuOpen = null;
          }}
        >
          <Scissors class="size-4" aria-hidden="true" />
          <span>{tUi('ink.toolbar.cutSelected')}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          disabled={!hasSelection}
          onclick={() => {
            if (copySelection()) toolbarMenuOpen = null;
          }}
        >
          <Copy class="size-4" aria-hidden="true" />
          <span>{tUi('ink.toolbar.copySelected')}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          disabled={isTrashed || !hasSelectionClipboard}
          onclick={() => {
            if (pasteSelection()) toolbarMenuOpen = null;
          }}
        >
          <ClipboardPaste class="size-4" aria-hidden="true" />
          <span>{tUi('ink.toolbar.pasteInk')}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm text-destructive hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
          disabled={isTrashed || !hasSelection}
          onclick={() => {
            if (deleteSelection()) toolbarMenuOpen = null;
          }}
        >
          <Trash2 class="size-4" aria-hidden="true" />
          <span>{tUi('ink.toolbar.deleteSelected')}</span>
        </button>
      </div>
    {/if}
  </div>
{/snippet}

{#snippet inkToolbar(dense: boolean, className: string)}
  <Toolbar {dense} aria-label={tUi('ink.toolbar.label')} class={className}>
    <div class="flex min-w-0 flex-1 items-center gap-0.5">
      <div class="flex shrink-0 items-center gap-0.5">
        <ToolbarButton
          active={tool === 'pen'}
          aria-label={tUi('ink.toolbar.pen')}
          title={tUi('ink.toolbar.pen')}
          aria-pressed={tool === 'pen'}
          onclick={() => setTool('pen')}
        >
          <PenLine aria-hidden="true" />
        </ToolbarButton>

        <ToolbarButton
          active={tool === 'eraser'}
          aria-label={tUi('ink.toolbar.eraser')}
          title={tUi('ink.toolbar.eraser')}
          aria-pressed={tool === 'eraser'}
          onclick={() => setTool('eraser')}
        >
          <Eraser aria-hidden="true" />
        </ToolbarButton>

        <ToolbarButton
          active={tool === 'lasso'}
          aria-label={tUi('ink.toolbar.lasso')}
          title={tUi('ink.toolbar.lasso')}
          aria-pressed={tool === 'lasso'}
          onclick={() => setTool('lasso')}
        >
          <LassoSelect aria-hidden="true" />
        </ToolbarButton>
      </div>

      <ToolbarSeparator />

      <div class="relative shrink-0">
        <ToolbarButton
          bind:ref={styleMenuButton}
          wide
          active={toolbarMenuOpen === 'style'}
          aria-label={tUi('ink.toolbar.style')}
          title={tUi('ink.toolbar.style')}
          aria-haspopup="menu"
          aria-expanded={toolbarMenuOpen === 'style'}
          onclick={() => toggleToolbarMenu('style')}
        >
          <Palette aria-hidden="true" />
          <span class="grid h-5 w-8 place-items-center" aria-hidden="true">
            <span
              class="block w-7 rounded-full"
              style="height: {brushLineHeight}px; background-color: {colorHex};"
            ></span>
          </span>
          <span class="w-6 text-center text-xs tabular-nums">
            {brushSizeText}
          </span>
        </ToolbarButton>

        {#if toolbarMenuOpen === 'style'}
          <div
            bind:this={styleMenuEl}
            role="menu"
            class="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg"
            aria-label={tUi('ink.toolbar.style')}
          >
            <div
              class="grid grid-cols-6 gap-1"
              role="group"
              aria-label={tUi('ink.toolbar.colorPresets')}
            >
              {#each INK_COLOR_SWATCHES as swatch, index (swatch)}
                {@const activeSwatch = colorArgb === colorHexToArgb(swatch)}
                <button
                  type="button"
                  role="menuitemradio"
                  class={`grid size-8 place-items-center rounded-md border border-border transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${activeSwatch ? 'ring-2 ring-ring' : ''}`}
                  aria-label={`${tUi('ink.toolbar.colorPreset')} ${index + 1}`}
                  aria-checked={activeSwatch}
                  title={`${tUi('ink.toolbar.colorPreset')} ${index + 1}`}
                  onclick={() => selectPresetColor(swatch)}
                >
                  <span
                    class="size-5 rounded-full border border-black/20 shadow-sm"
                    style="background-color: {swatch};"
                    aria-hidden="true"
                  ></span>
                </button>
              {/each}
            </div>

            <div
              class="mt-2 flex h-10 items-center gap-2 rounded-md px-2"
              aria-label={tUi('ink.toolbar.color')}
            >
              <label
                class="relative grid size-7 shrink-0 cursor-pointer place-items-center rounded-md border border-border bg-background shadow-sm focus-within:ring-2 focus-within:ring-ring"
                title={tUi('ink.toolbar.color')}
              >
                <span
                  class="size-5 rounded-sm border border-black/15"
                  style="background-color: {colorHex};"
                  aria-hidden="true"
                ></span>
                <input
                  class="absolute inset-0 cursor-pointer opacity-0"
                  type="color"
                  aria-label={tUi('ink.toolbar.color')}
                  value={colorHex}
                  oninput={(e) => setColor(e.currentTarget.value)}
                />
              </label>
              <label class="min-w-0 flex-1">
                <span class="sr-only">{tUi('ink.toolbar.colorHex')}</span>
                <input
                  class="h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-xs uppercase text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={tUi('ink.toolbar.colorHex')}
                  spellcheck="false"
                  maxlength="7"
                  value={colorInputText}
                  oninput={(e) => setColorInputText(e.currentTarget.value)}
                />
              </label>
            </div>

            <div
              class="mt-2 rounded-md px-2 py-1.5"
              aria-label={`${tUi('ink.toolbar.brushSize')}: ${brushSizeText}`}
              title={`${tUi('ink.toolbar.brushSize')}: ${brushSizeText}`}
            >
              <div class="mb-1 flex items-center justify-between gap-3">
                <span class="text-xs text-muted-foreground">
                  {tUi('ink.toolbar.brushSize')}
                </span>
                <span class="text-xs font-medium tabular-nums">
                  {brushSizeText}
                </span>
              </div>
              <div class="flex items-center gap-2">
                <span
                  class="grid h-6 w-10 place-items-center"
                  aria-hidden="true"
                >
                  <span
                    class="block w-9 rounded-full"
                    style="height: {brushLineHeight}px; background-color: {colorHex};"
                  ></span>
                </span>
                <input
                  class="h-2 min-w-0 flex-1 accent-primary"
                  aria-label={tUi('ink.toolbar.brushSize')}
                  title={tUi('ink.toolbar.brushSize')}
                  type="range"
                  min="0.5"
                  max="12"
                  step="0.5"
                  value={width}
                  oninput={(e) => setWidth(e.currentTarget.value)}
                />
              </div>
            </div>
          </div>
        {/if}
      </div>

      <ToolbarSeparator />

      <div class="flex shrink-0 items-center gap-0.5">
        <ToolbarButton
          aria-label={tUi('ink.toolbar.undo')}
          title={tUi('ink.toolbar.undo')}
          disabled={isTrashed || !doc || undoDepth === 0}
          onclick={undo}
        >
          <Undo2 aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          aria-label={tUi('ink.toolbar.redo')}
          title={tUi('ink.toolbar.redo')}
          disabled={isTrashed || !doc || redoDepth === 0}
          onclick={redo}
        >
          <Redo2 aria-hidden="true" />
        </ToolbarButton>
      </div>

      {#if hasSelection || hasSelectionClipboard}
        <ToolbarSeparator />
        <ToolbarCollapseWhenOverflow
          class="items-center gap-0.5"
          margin={6}
          expanded={selectionActionsExpanded}
          collapsed={selectionActionsCollapsed}
        />
      {/if}

      <div class="ml-auto flex shrink-0 items-center gap-0.5 pl-2">
        <ToolbarSeparator />
        <div class="relative shrink-0">
          <ToolbarButton
            bind:ref={settingsMenuButton}
            active={toolbarMenuOpen === 'settings'}
            aria-label={tUi('ink.toolbar.settings')}
            title={tUi('ink.toolbar.settings')}
            aria-haspopup="menu"
            aria-expanded={toolbarMenuOpen === 'settings'}
            onclick={() => toggleToolbarMenu('settings')}
          >
            <Settings2 aria-hidden="true" />
          </ToolbarButton>

          {#if toolbarMenuOpen === 'settings'}
            <div
              bind:this={settingsMenuEl}
              role="menu"
              class="absolute right-0 top-full z-50 mt-1 min-w-52 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
              aria-label={tUi('ink.toolbar.settings')}
            >
              <button
                type="button"
                role="menuitemcheckbox"
                class="flex h-8 w-full items-center justify-between gap-3 rounded-sm px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                aria-checked={fingerDrawingAllowed}
                onclick={toggleFingerDrawing}
              >
                <span>{tUi('ink.toolbar.fingerDrawing')}</span>
                <MousePointer2
                  class="size-4 {fingerDrawingAllowed
                    ? 'opacity-100'
                    : 'opacity-35'}"
                  aria-hidden="true"
                />
              </button>
              <button
                type="button"
                role="menuitem"
                class="flex h-8 w-full items-center justify-between gap-3 rounded-sm px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                onclick={cyclePageTheme}
              >
                <span>{tUi('ink.toolbar.pageTheme')}</span>
                <span class="flex items-center gap-1.5 text-muted-foreground">
                  <span class="text-xs">
                    {tValue('editor.ink.pageTheme', pageThemeMode)}
                  </span>
                  {#if pageThemeMode === 'dark'}
                    <MoonStar class="size-4" aria-hidden="true" />
                  {:else if pageThemeMode === 'system'}
                    <Monitor class="size-4" aria-hidden="true" />
                  {:else}
                    <Sun class="size-4" aria-hidden="true" />
                  {/if}
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                class="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm text-destructive hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
                disabled={isTrashed || strokeCount === 0}
                onclick={() => {
                  toolbarMenuOpen = null;
                  void confirmClearCanvas();
                }}
              >
                <Shredder class="size-4" aria-hidden="true" />
                <span>{clearButtonLabel}</span>
              </button>
            </div>
          {/if}
        </div>
      </div>
    </div>
  </Toolbar>
{/snippet}

<div
  bind:this={hostEl}
  class="relative flex h-full w-full flex-col overflow-hidden bg-background"
>
  {#if mobileToolbar}
    <div
      bind:this={toolbarEl}
      class="pointer-events-auto absolute left-3 top-3 z-30"
    >
      {@render inkToolbar(
        false,
        'rounded-md border border-border bg-background/95 shadow-sm backdrop-blur'
      )}
    </div>
  {:else}
    <div bind:this={toolbarEl} class="shrink-0">
      {@render inkToolbar(
        true,
        'shrink-0 border-b border-border bg-background'
      )}
    </div>
  {/if}

  <div bind:this={canvasHostEl} class="relative min-h-0 flex-1">
    <canvas
      bind:this={resizeSnapshotCanvasEl}
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 z-0 block h-full w-full opacity-0 transition-opacity duration-75 {resizeSnapshotVisible
        ? 'opacity-100'
        : 'opacity-0'}"
    ></canvas>
    <canvas
      bind:this={canvasEl}
      class="relative z-10 block h-full w-full touch-none {tool === 'eraser'
        ? 'cursor-none'
        : tool === 'pen'
          ? 'cursor-crosshair'
          : 'cursor-default'}"
      tabindex="0"
      aria-label={ariaLabel}
      onpointerenter={handlePointerEnter}
      onpointerleave={handlePointerLeave}
      onpointerdown={handlePointerDown}
      onpointermove={handlePointerMove}
      onpointerup={handlePointerUp}
      onpointercancel={handlePointerCancel}
      onwheel={handleWheel}
    ></canvas>
  </div>

  {#if !mobileToolbar}
    <div
      class="absolute bottom-3 left-3 z-20"
      role="toolbar"
      aria-label={tUi('ink.toolbar.zoom')}
    >
      <ToolbarZoomControls
        bind:open={zoomMenuOpen}
        class="rounded-md border border-border bg-background/95 p-1 shadow-sm backdrop-blur"
        menuPlacement="above"
        label={inkZoomLabel}
        zoomOutLabel={tUi('ink.toolbar.zoomOut')}
        zoomInLabel={tUi('ink.toolbar.zoomIn')}
        zoomMenuLabel={tUi('ink.toolbar.zoom')}
        fitLabel={tUi('ink.toolbar.fitWidth')}
        fitActive={inkFitActive}
        zoomOptions={INK_QUICK_ZOOMS}
        selectedZoom={inkFitActive ? null : displayInkZoom(view.scale)}
        onZoomOut={() => zoomInkBy(1 / INK_ZOOM_STEP)}
        onZoomIn={() => zoomInkBy(INK_ZOOM_STEP)}
        onFit={setFitWidthZoom}
        onSelectZoom={setInkDisplayZoom}
      />
    </div>
  {/if}
</div>
