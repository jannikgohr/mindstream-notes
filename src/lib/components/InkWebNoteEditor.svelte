<script lang="ts">
  import * as Y from 'yjs';
  import { onDestroy, onMount, tick } from 'svelte';
  import {
    Eraser,
    MousePointer2,
    MoonStar,
    PenLine,
    Redo2,
    Sun,
    Trash2,
    Undo2
  } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    drawingCancelLiveInk,
    drawingHideLiveInkOverlay,
    drawingSaveInkState,
    drawingSetLiveInkFingerDrawing,
    drawingSetLiveInkStyle,
    drawingShowLiveInkOverlay,
    loadNote,
    noteRoomInfo,
    onSessionChange,
    TRASH_ID,
    type DrawingToolbarSettings,
    type DrawingToolbarSettingsPayload
  } from '$lib/api';
  import { isAndroid } from '$lib/platform';
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
  import { tree } from '$lib/stores/tree.svelte';
  import { InkWebCollabProvider } from '$lib/sync/ink-web-collab-provider';
  import {
    DEFAULT_COLOR,
    DEFAULT_WIDTH,
    InkDocument,
    type StrokeBounds
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

  interface Props {
    noteId: string;
    ariaLabel: string;
  }

  let { noteId, ariaLabel }: Props = $props();

  const SAVE_DEBOUNCE_MS = 800;
  const ERASER_RADIUS = 10;
  const PAGE_FILL_LIGHT = 0xffffffff;
  const PAGE_BG_LIGHT = 0xfff1f2f4;
  const PAGE_BORDER_LIGHT = 0xffe5e7eb;
  const PAGE_SHADOW_LIGHT = 'rgba(0, 0, 0, 0.14)';
  const PAGE_SHADOW_DARK = 'rgba(255, 255, 255, 0.2)';
  const POINTER_BUTTON_SECONDARY = 2;
  const POINTER_BUTTON_STYLUS_PRIMARY = 32;
  const POINTER_BUTTON_STYLUS_SECONDARY = 64;

  const INK_TOOL_SETTING = 'editor.ink.tool';
  const INK_COLOR_SETTING = 'editor.ink.color';
  const INK_WIDTH_SETTING = 'editor.ink.width';
  const INK_FINGER_SETTING = 'editor.ink.fingerDrawing';
  const INK_PAGE_THEME_SETTING = 'editor.ink.pageTheme';

  type ToolMode = 'pen' | 'eraser';
  type PageThemeMode = 'light' | 'system';
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
  type WebInkHandleInstance = {
    encode_state_vector: () => Uint8Array;
    encode_diff_for_state_vector: (stateVector: Uint8Array) => Uint8Array;
    apply_remote_update: (update: Uint8Array) => boolean;
  };

  let hostEl = $state<HTMLDivElement | null>(null);
  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let doc = $state<InkDocument | null>(null);
  let handle: WebInkHandleInstance | null = null;
  let provider: InkWebCollabProvider | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let disposed = false;
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

  let tool = $state<ToolMode>('pen');
  let colorArgb = $state(DEFAULT_COLOR);
  let width = $state(DEFAULT_WIDTH);
  let fingerDrawingAllowed = $state(true);
  let pageThemeMode = $state<PageThemeMode>('light');
  let strokeCount = $state(0);
  let inFlight = $state<InkPoint[]>([]);
  let undoDepth = $state(0);
  let redoDepth = $state(0);
  let eraserHits = new Set<string>();
  let androidStylusEraserHits = new Set<string>();
  let androidStylusEraserActive = false;
  let pointerMode: 'draw' | 'erase' | 'pan' | null = null;
  let activePointerId: number | null = null;
  let lastPointer: { x: number; y: number } | null = null;
  let drawingStrokeActive = false;
  let queuedEraserSamples: QueuedEraserSample[] = [];
  let eraserFrame: number | null = null;
  let drawFrame: number | null = null;
  const cssColorCache = new Map<number, string>();
  let layout = defaultLayout();
  let view = {
    width: 1,
    height: 1,
    scale: 1,
    panX: 0,
    panY: DEFAULT_PAGE_GAP
  };

  const pageDark = $derived(pageThemeMode === 'system');
  const colorHex = $derived(argbToColorHex(colorArgb));

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
    strokeCount;
    inFlight;
    tool;
    colorArgb;
    width;
    pageThemeMode;
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
    void drawingSetLiveInkStyle(liveColorArgb, minWidthPx, maxWidthPx);
    void drawingSetLiveInkFingerDrawing(fingerDrawingAllowed);
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
    syncHistoryState();
    const maxY = doc.contentMaxY();
    layout = defaultLayout(pageCountForContentMaxY(maxY));
    clampView();
    scheduleDraw();
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

    const collabUrl = (
      (getSettingValue('account.collabServerUrl') as string | undefined) ?? ''
    ).trim();
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
    if (!hostEl || !canvasEl) return;
    const rect = hostEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const widthPx = Math.max(1, Math.floor(rect.width * dpr));
    const heightPx = Math.max(1, Math.floor(rect.height * dpr));
    if (canvasEl.width !== widthPx || canvasEl.height !== heightPx) {
      canvasEl.width = widthPx;
      canvasEl.height = heightPx;
    }
    view.width = rect.width;
    view.height = rect.height;
    if (view.scale <= 1) {
      fitWidth();
    } else {
      clampView();
    }
    scheduleDraw();
    updateLiveInkOverlayStyle();
  }

  function fitWidth() {
    view.scale = Math.max(0.05, (view.width - 32) / layout.page.width);
    view.panX = (view.width - layout.page.width * view.scale) * 0.5;
    view.panY = DEFAULT_PAGE_GAP * view.scale;
    clampView();
  }

  function clampView() {
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
    const margin = layout.pageGap * view.scale;
    const minY = view.height - contentH - margin;
    const maxY = margin;
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
    if (drawFrame !== null) return;
    drawFrame = requestAnimationFrame(() => {
      drawFrame = null;
      draw();
    });
  }

  function draw() {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const visibleBounds = visiblePageBounds();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.fillStyle = displayCssColor(PAGE_BG_LIGHT);
    ctx.fillRect(0, 0, view.width, view.height);

    drawPages(ctx, visibleBounds);
    const visibleStrokes = doc?.visibleStrokesInBounds(visibleBounds, 2) ?? [];
    for (const stroke of visibleStrokes) {
      drawStroke(
        ctx,
        stroke.points,
        displayCssColor(stroke.color),
        stroke.width
      );
    }
    drawStroke(ctx, inFlight, displayCssColor(colorArgb), width);
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
      ctx.fillStyle = pageDark ? PAGE_SHADOW_DARK : PAGE_SHADOW_LIGHT;
      ctx.fillRect(a.x + 3, a.y + 3, b.x - a.x, b.y - a.y);
      ctx.fillStyle = displayCssColor(PAGE_FILL_LIGHT);
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeStyle = displayCssColor(PAGE_BORDER_LIGHT);
      ctx.lineWidth = 1;
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    }
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

  function pointerSamples(event: PointerEvent): PointerEvent[] {
    const samples = event.getCoalescedEvents?.() ?? [];
    return samples.length > 0 ? samples : [event];
  }

  function clientPoint(
    clientX: number,
    clientY: number,
    pressure: number
  ): InkPoint {
    const rect = canvasEl?.getBoundingClientRect();
    const x = clientX - (rect?.left ?? 0);
    const y = clientY - (rect?.top ?? 0);
    const p = screenToPage(x, y);
    p.pressure = sanitizePressure(pressure);
    return p;
  }

  function eventPoint(event: PointerEvent): InkPoint {
    return clientPoint(event.clientX, event.clientY, event.pressure);
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

  function handlePointerDown(event: PointerEvent) {
    if (!doc || !canvasEl) return;
    event.preventDefault();
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
    if (tool === 'eraser' || isStylusButtonErasing(event)) {
      pointerMode = 'erase';
      eraserHits.clear();
      eraseFromEvent(event);
      return;
    }
    pointerMode = 'draw';
    inFlight = [];
    drawingStrokeActive = false;
    pushPointerSamples(event);
  }

  function handlePointerMove(event: PointerEvent) {
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
      eraseFromEvent(event);
      return;
    }
    if (pointerMode === 'draw') {
      event.preventDefault();
      if (isStylusButtonErasing(event)) {
        finishActiveStroke();
        pointerMode = 'erase';
        eraserHits.clear();
        eraseFromEvent(event);
        return;
      }
      pushPointerSamples(event);
    }
  }

  function handlePointerUp(event: PointerEvent) {
    if (activePointerId !== event.pointerId) return;
    event.preventDefault();
    if (pointerMode === 'draw' && doc) {
      if (!isStylusButtonErasing(event)) {
        pushPointerSamples(event);
      }
      finishActiveStroke();
    } else if (pointerMode === 'erase' && doc) {
      flushQueuedEraserSamples();
      doc.finishEraserDrag(eraserHits);
      syncHistoryState();
    }
    resetPointer();
  }

  function handlePointerCancel(event: PointerEvent) {
    if (activePointerId !== event.pointerId) return;
    if (pointerMode === 'erase' && doc) {
      flushQueuedEraserSamples();
      doc.finishEraserDrag(eraserHits);
      syncHistoryState();
    } else {
      clearQueuedEraserSamples();
    }
    cancelActiveStroke();
    inFlight = [];
    resetPointer();
    scheduleDraw();
  }

  function pushPointerSamples(event: PointerEvent) {
    if (!doc) return;
    if (isStylusButtonErasing(event)) return;
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
      const before = screenToPage(event.offsetX, event.offsetY);
      view.scale = Math.min(
        Math.max(view.scale * factor, minScale()),
        minScale() * 6
      );
      view.panX = event.offsetX - before.x * view.scale;
      view.panY = event.offsetY - before.y * view.scale;
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

  function minScale(): number {
    return Math.min(
      view.width / layout.page.width,
      view.height / layout.page.height
    );
  }

  function setTool(next: ToolMode) {
    tool = next;
    emitToolbarSettings();
    updateLiveInkOverlayStyle();
  }

  function setColor(value: string) {
    colorArgb = colorHexToArgb(value);
    emitToolbarSettings();
    updateLiveInkOverlayStyle();
  }

  function setWidth(value: string) {
    width = normalizeInkWidth(Number(value));
    emitToolbarSettings();
    updateLiveInkOverlayStyle();
  }

  function toggleFingerDrawing() {
    fingerDrawingAllowed = !fingerDrawingAllowed;
    emitToolbarSettings();
    updateLiveInkOverlayStyle();
  }

  function togglePageTheme() {
    pageThemeMode = pageThemeMode === 'system' ? 'light' : 'system';
    emitToolbarSettings();
  }

  function undo() {
    if (!doc) return;
    flushQueuedEraserSamples();
    const { value, update } = doc.undoLast();
    if (value) applyDocumentMutation(update);
  }

  function redo() {
    if (!doc) return;
    flushQueuedEraserSamples();
    const { value, update } = doc.redoLast();
    if (value) applyDocumentMutation(update);
  }

  function clearCanvas() {
    if (!doc) return;
    flushQueuedEraserSamples();
    const { value, update } = doc.clearAll();
    if (value.length > 0) applyDocumentMutation(update);
  }

  function normalizeInkTool(value: unknown): ToolMode {
    return value === 'eraser' ? 'eraser' : 'pen';
  }

  function normalizeInkPageTheme(value: unknown): PageThemeMode {
    return value === 'system' ? 'system' : 'light';
  }

  function normalizeInkWidth(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? Math.min(12, Math.max(0.5, n)) : DEFAULT_WIDTH;
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

  function displayColor(argb: number): number {
    if (!pageDark) return argb >>> 0;
    return (argb & 0xff000000) | (~argb & 0x00ffffff);
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
    window.addEventListener(
      'mindstream:android-stylus-eraser',
      handleAndroidStylusEraser
    );
    await tick();
    const afterTickAt = performance.now();
    if (isAndroid()) {
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
    resizeObserver = new ResizeObserver(resizeCanvas);
    if (hostEl) resizeObserver.observe(hostEl);
    toolbarSettingsReady = true;
    lastSeenPushed = tree.notesById[noteId]?.pushed ?? false;
    await setupCollabProvider();
    collabReady = true;
    unsubSession = onSessionChange(() => {
      void setupCollabProvider();
    });
  });

  onDestroy(() => {
    window.removeEventListener(
      'mindstream:android-stylus-eraser',
      handleAndroidStylusEraser
    );
    flushQueuedEraserSamples();
    clearSaveTimer();
    void flushPendingState();
    if (drawFrame !== null) {
      cancelAnimationFrame(drawFrame);
      drawFrame = null;
    }
    if (isAndroid()) {
      void drawingHideLiveInkOverlay();
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

<div
  bind:this={hostEl}
  class="relative h-full w-full overflow-hidden bg-muted/20"
>
  <div
    class="absolute left-3 top-3 z-10 flex h-10 items-center gap-1 rounded-md border border-border bg-background/95 px-1 shadow-sm"
  >
    <Button
      size="icon"
      variant={tool === 'pen' ? 'default' : 'ghost'}
      aria-label="Pen"
      title="Pen"
      onclick={() => setTool('pen')}
    >
      <PenLine class="size-4" />
    </Button>
    <Button
      size="icon"
      variant={tool === 'eraser' ? 'default' : 'ghost'}
      aria-label="Eraser"
      title="Eraser"
      onclick={() => setTool('eraser')}
    >
      <Eraser class="size-4" />
    </Button>
    <label
      class="grid size-9 place-items-center rounded-md hover:bg-accent"
      aria-label="Color"
      title="Color"
    >
      <input
        class="size-6 cursor-pointer border-0 bg-transparent p-0"
        type="color"
        value={colorHex}
        oninput={(e) => setColor(e.currentTarget.value)}
      />
    </label>
    <input
      class="h-2 w-24 accent-primary"
      aria-label="Brush size"
      title="Brush size"
      type="range"
      min="0.5"
      max="12"
      step="0.5"
      value={width}
      oninput={(e) => setWidth(e.currentTarget.value)}
    />
    <Button
      size="icon"
      variant="ghost"
      aria-label="Undo"
      title="Undo"
      disabled={isTrashed || !doc || undoDepth === 0}
      onclick={undo}
    >
      <Undo2 class="size-4" />
    </Button>
    <Button
      size="icon"
      variant="ghost"
      aria-label="Redo"
      title="Redo"
      disabled={isTrashed || !doc || redoDepth === 0}
      onclick={redo}
    >
      <Redo2 class="size-4" />
    </Button>
    <Button
      size="icon"
      variant="ghost"
      aria-label="Finger drawing"
      title="Finger drawing"
      onclick={toggleFingerDrawing}
    >
      <MousePointer2
        class={`size-4 ${fingerDrawingAllowed ? '' : 'opacity-40'}`}
      />
    </Button>
    <Button
      size="icon"
      variant="ghost"
      aria-label="Page theme"
      title="Page theme"
      onclick={togglePageTheme}
    >
      {#if pageThemeMode === 'system'}
        <MoonStar class="size-4" />
      {:else}
        <Sun class="size-4" />
      {/if}
    </Button>
    <Button
      size="icon"
      variant="ghost"
      aria-label="Clear"
      title="Clear"
      disabled={isTrashed}
      onclick={clearCanvas}
    >
      <Trash2 class="size-4" />
    </Button>
  </div>
  <canvas
    bind:this={canvasEl}
    class="block h-full w-full touch-none"
    aria-label={ariaLabel}
    onpointerdown={handlePointerDown}
    onpointermove={handlePointerMove}
    onpointerup={handlePointerUp}
    onpointercancel={handlePointerCancel}
    onwheel={handleWheel}
  ></canvas>
</div>
