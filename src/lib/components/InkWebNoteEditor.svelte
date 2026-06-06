<script lang="ts">
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
    drawingSaveInkState,
    loadNote,
    noteRoomInfo,
    onSessionChange,
    TRASH_ID,
    type DrawingToolbarSettings,
    type DrawingToolbarSettingsPayload
  } from '$lib/api';
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
    type InkStroke
  } from '$lib/ink/document';
  import {
    DEFAULT_PAGE_GAP,
    defaultLayout,
    pageCountForContentMaxY,
    pageRect,
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

  const INK_TOOL_SETTING = 'editor.ink.tool';
  const INK_COLOR_SETTING = 'editor.ink.color';
  const INK_WIDTH_SETTING = 'editor.ink.width';
  const INK_FINGER_SETTING = 'editor.ink.fingerDrawing';
  const INK_PAGE_THEME_SETTING = 'editor.ink.pageTheme';

  type ToolMode = 'pen' | 'eraser';
  type PageThemeMode = 'light' | 'system';
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
  let strokes = $state<InkStroke[]>([]);
  let inFlight = $state<InkPoint[]>([]);
  let eraserHits = new Set<string>();
  let pointerMode: 'draw' | 'erase' | 'pan' | null = null;
  let activePointerId: number | null = null;
  let lastPointer: { x: number; y: number } | null = null;
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
    strokes;
    inFlight;
    tool;
    colorArgb;
    width;
    pageThemeMode;
    draw();
  });

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
    const state = pendingState;
    if (!state || disposed) return;
    pendingState = null;
    savingState = 'saving';
    try {
      await drawingSaveInkState(noteId, state);
      savingState = 'saved';
    } catch (err) {
      pendingState = state;
      savingState = 'error';
      console.warn('[ink-canvas] failed to save note', err);
    }
  }

  function scheduleSave() {
    if (!doc) return;
    pendingState = Array.from(doc.encode());
    savingState = 'pending';
    clearSaveTimer();
    saveTimer = setTimeout(() => void flushPendingState(), SAVE_DEBOUNCE_MS);
  }

  function applyDocumentMutation(update: Uint8Array | null) {
    refreshFromDoc();
    scheduleSave();
    if (update) {
      provider?.sendLocalUpdate(update);
    }
  }

  function refreshFromDoc() {
    if (!doc) return;
    strokes = doc.visibleStrokes();
    const maxY = strokes
      .flatMap((stroke) => stroke.points.map((p) => p.y))
      .reduce((max, y) => Math.max(max, y), 0);
    layout = defaultLayout(pageCountForContentMaxY(maxY));
    clampView();
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
    draw();
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

  function draw() {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.fillStyle = cssColor(displayColor(PAGE_BG_LIGHT));
    ctx.fillRect(0, 0, view.width, view.height);

    drawPages(ctx);
    for (const stroke of strokes) {
      drawStroke(ctx, stroke.points, displayColor(stroke.color), stroke.width);
    }
    drawStroke(ctx, inFlight, displayColor(colorArgb), width);
  }

  function drawPages(ctx: CanvasRenderingContext2D) {
    for (let i = 0; i < layout.pageCount; i += 1) {
      const rect = pageRect(layout, i);
      if (!rect) continue;
      const [x0, y0, x1, y1] = rect;
      const a = pageToScreen({ x: x0, y: y0 });
      const b = pageToScreen({ x: x1, y: y1 });
      ctx.fillStyle = pageDark ? PAGE_SHADOW_DARK : PAGE_SHADOW_LIGHT;
      ctx.fillRect(a.x + 3, a.y + 3, b.x - a.x, b.y - a.y);
      ctx.fillStyle = cssColor(displayColor(PAGE_FILL_LIGHT));
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeStyle = cssColor(displayColor(PAGE_BORDER_LIGHT));
      ctx.lineWidth = 1;
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    }
  }

  function drawStroke(
    ctx: CanvasRenderingContext2D,
    points: InkPoint[],
    color: number,
    baseWidth: number
  ) {
    if (points.length < 2) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = cssColor(color);
    for (let i = 1; i < points.length; i += 1) {
      const a = pageToScreen(points[i - 1]);
      const b = pageToScreen(points[i]);
      const pressure = (points[i - 1].pressure + points[i].pressure) * 0.5;
      ctx.lineWidth = Math.max(
        1,
        baseWidth * view.scale * pressureWidth(pressure)
      );
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
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

  function eventPoint(event: PointerEvent): InkPoint {
    const rect = canvasEl?.getBoundingClientRect();
    const x = event.clientX - (rect?.left ?? 0);
    const y = event.clientY - (rect?.top ?? 0);
    const p = screenToPage(x, y);
    p.pressure = sanitizePressure(event.pressure);
    return p;
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
    if (tool === 'eraser') {
      pointerMode = 'erase';
      eraserHits.clear();
      eraseFromEvent(event);
      return;
    }
    pointerMode = 'draw';
    inFlight = [];
    doc.beginStroke(colorArgb, width);
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
        draw();
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
      pushPointerSamples(event);
    }
  }

  function handlePointerUp(event: PointerEvent) {
    if (activePointerId !== event.pointerId) return;
    event.preventDefault();
    if (pointerMode === 'draw' && doc) {
      pushPointerSamples(event);
      const { update } = doc.endStroke();
      inFlight = [];
      applyDocumentMutation(update);
    } else if (pointerMode === 'erase' && doc) {
      doc.finishEraserDrag(eraserHits);
      scheduleSave();
    }
    resetPointer();
  }

  function handlePointerCancel(event: PointerEvent) {
    if (activePointerId !== event.pointerId) return;
    doc?.cancelStroke();
    inFlight = [];
    resetPointer();
    draw();
  }

  function pushPointerSamples(event: PointerEvent) {
    if (!doc) return;
    const next = [...inFlight];
    for (const sample of pointerSamples(event)) {
      const point = eventPoint(sample);
      const last = next[next.length - 1];
      if (last && Math.hypot(point.x - last.x, point.y - last.y) < 1.5) {
        continue;
      }
      doc.pushPoint(point.x, point.y, point.pressure);
      next.push(point);
    }
    inFlight = next;
  }

  function eraseFromEvent(event: PointerEvent) {
    if (!doc) return;
    for (const sample of pointerSamples(event)) {
      const point = eventPoint(sample);
      const { value: erased, update } = doc.eraseAt(point, ERASER_RADIUS);
      for (const id of erased) {
        eraserHits.add(id);
      }
      if (erased.length > 0) {
        applyDocumentMutation(update);
      }
    }
  }

  function resetPointer() {
    pointerMode = null;
    activePointerId = null;
    lastPointer = null;
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
    draw();
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
  }

  function setColor(value: string) {
    colorArgb = colorHexToArgb(value);
    emitToolbarSettings();
  }

  function setWidth(value: string) {
    width = normalizeInkWidth(Number(value));
    emitToolbarSettings();
  }

  function toggleFingerDrawing() {
    fingerDrawingAllowed = !fingerDrawingAllowed;
    emitToolbarSettings();
  }

  function togglePageTheme() {
    pageThemeMode = pageThemeMode === 'system' ? 'light' : 'system';
    emitToolbarSettings();
  }

  function undo() {
    if (!doc) return;
    const { value, update } = doc.undoLast();
    if (value) applyDocumentMutation(update);
  }

  function redo() {
    if (!doc) return;
    const { value, update } = doc.redoLast();
    if (value) applyDocumentMutation(update);
  }

  function clearCanvas() {
    if (!doc) return;
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

  function cssColor(argb: number): string {
    const a = ((argb >>> 24) & 0xff) / 255;
    const r = (argb >>> 16) & 0xff;
    const g = (argb >>> 8) & 0xff;
    const b = argb & 0xff;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
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
    await tick();
    const note = await loadNote(noteId);
    if (disposed) return;
    doc = InkDocument.fromBytes(new Uint8Array(note.yrs_state));
    handle = {
      encode_state_vector: () => doc?.encodeStateVector() ?? new Uint8Array(),
      encode_diff_for_state_vector: (stateVector) =>
        doc?.encodeDiffForStateVector(stateVector) ?? new Uint8Array(),
      apply_remote_update: (update) => {
        const applied = doc?.applyRemoteUpdate(update) ?? false;
        if (applied) {
          refreshFromDoc();
          scheduleSave();
          draw();
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
    clearSaveTimer();
    void flushPendingState();
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
      disabled={isTrashed || !doc || doc.undo.length === 0}
      onclick={undo}
    >
      <Undo2 class="size-4" />
    </Button>
    <Button
      size="icon"
      variant="ghost"
      aria-label="Redo"
      title="Redo"
      disabled={isTrashed || !doc || doc.redo.length === 0}
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
