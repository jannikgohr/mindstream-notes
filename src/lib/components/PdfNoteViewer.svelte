<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
  import {
    AlertCircle,
    Check,
    ChevronDown,
    Download,
    FileText,
    Highlighter,
    Loader2,
    MessageSquarePlus,
    MessagesSquare,
    Minus,
    MousePointer2,
    PenLine,
    Plus,
    Signature,
    Trash2
  } from 'lucide-svelte';
  import * as Y from 'yjs';
  import { Awareness } from 'y-protocols/awareness';
  import { Button } from '$lib/components/ui/button';
  import {
    etebaseSession,
    fetchDrawingAsset,
    loadNote,
    noteRoomInfo,
    onSessionChange,
    saveNote as apiSaveNote
  } from '$lib/api';
  import { listen } from '$lib/api/events';
  import { base64ToBytes } from '$lib/editor/base64';
  import { pickCursorColor } from '$lib/editor/cursor-color';
  import { getSettingValue } from '$lib/settings/store.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { saveAnnotatedPdf } from '$lib/api/pdf-export';
  import { exportAnnotatedPdf } from '$lib/pdf/export-annotated-pdf';
  import {
    PDF_ANNOTATIONS_MAP,
    type PdfAnnotation,
    type PdfAnnotationType,
    type PdfInkStroke,
    type PdfRect,
    type PdfSignatureSnapshot,
    type PdfStrokePoint
  } from '$lib/pdf/types';
  import { CollabProvider } from '$lib/sync/collab-provider';
  import { tree } from '$lib/stores/tree.svelte';
  import {
    clearNoteStatus,
    setNoteStatus
  } from '$lib/stores/note-status.svelte';

  interface Props {
    noteId: string;
  }
  let { noteId }: Props = $props();

  type PdfJs = typeof import('pdfjs-dist');
  type PdfViewer = typeof import('pdfjs-dist/web/pdf_viewer.mjs');
  type PdfDocument = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;
  type PdfPageView = InstanceType<PdfViewer['PDFPageView']>;
  type ZoomMode = 'fixed' | 'fit-width';
  type PdfTool =
    | 'select'
    | 'highlight'
    | 'comment'
    | 'pen'
    | 'signature'
    | 'delete';
  type RenderParams = {
    pageNumber: number;
    version: number;
    zoom: number;
    zoomMode: ZoomMode;
    annotationVersion: number;
    activeTool: PdfTool;
    selectedAnnotationId: string | null;
  };

  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 4;
  const ZOOM_STEP = 1.2;
  const QUICK_ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  const PDF_TO_CSS_UNITS = 96 / 72;
  const SAVE_DEBOUNCE_MS = 800;
  const HIGHLIGHT_COLOR = '#facc15';
  const COMMENT_COLOR = '#3b82f6';
  const SIGNATURE_COLOR = '#111827';
  const INK_COLOR = '#111827';
  const INK_WIDTH = 2.25;
  const SIGNATURE_STORAGE_KEY = 'mindstream.pdf.signatures.v1';
  const LEGACY_SIGNATURE_STORAGE_KEY = 'mindstream.pdf.signature.v1';
  const SIGNATURE_PAD_WIDTH = 420;
  const SIGNATURE_PAD_HEIGHT = 168;
  const SIGNATURE_MENU_WIDTH = 240;

  let container = $state<HTMLDivElement | null>(null);
  let zoomButton = $state<HTMLButtonElement | null>(null);
  let zoomMenuEl = $state<HTMLDivElement | null>(null);
  let pdfDoc = $state<PdfDocument | null>(null);
  let pageNumbers = $state<number[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let renderVersion = $state(0);
  let renderVersionCounter = 0;
  let zoom = $state(1);
  let zoomMode = $state<ZoomMode>('fixed');
  let firstPageWidth = $state(0);
  let zoomMenuOpen = $state(false);
  let menuRectVersion = $state(0);
  let annotationVersion = $state(0);
  let annotations = $state<PdfAnnotation[]>([]);
  let activeTool = $state<PdfTool>('select');
  let commentsSidebarOpen = $state(false);
  let selectedAnnotationId = $state<string | null>(null);
  let savedSignatures = $state<PdfSignatureSnapshot[]>([]);
  let activeSignatureId = $state<string | null>(null);
  let signatureDialogOpen = $state(false);
  let signaturePadStrokes = $state<PdfInkStroke[]>([]);
  let signaturePadDraft = $state<PdfInkStroke | null>(null);
  let signaturePickerOpen = $state(false);
  let signatureButton = $state<HTMLButtonElement | null>(null);
  let signaturePickerEl = $state<HTMLDivElement | null>(null);
  let signaturePickerRectVersion = $state(0);
  let savingState = $state<'idle' | 'pending' | 'saving' | 'saved' | 'error'>(
    'idle'
  );
  let isTrashed = $state(false);
  let collabConfigured = $state(false);
  let collabOnline = $state(false);
  let activePageNumber = $state(1);
  let exportInProgress = $state(false);
  let exportError = $state<string | null>(null);
  let pdfjsLib: PdfJs | null = null;
  let pdfViewerLib: PdfViewer | null = null;
  let yDoc: Y.Doc | null = null;
  let awareness: Awareness | null = null;
  let provider: CollabProvider | null = null;
  let annotationsMap: Y.Map<PdfAnnotation> | null = null;
  let yDocUpdateHandler: (() => void) | null = null;
  let saveReady = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubSync: (() => void) | null = null;
  let unsubSession: (() => void) | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let pageIntersectionObserver: IntersectionObserver | null = null;
  // Per-page visibility ratios — most-visible page wins as the awareness
  // pageIndex. Map (not array) because the observer fires per-page and
  // multiple pages can be partially visible during scroll.
  const pageVisibility = new Map<number, number>();
  // Tracks whether the post-create push has landed so we can re-init
  // the collab provider once the note becomes joinable. Mirrors the
  // pattern used in NoteEditor.svelte.
  let lastSeenPushed = false;
  let collabReady = false;

  $effect(() => {
    setNoteStatus(noteId, {
      collabConfigured,
      collabOnline,
      savingState: error ? 'error' : loading ? 'idle' : savingState,
      isTrashed
    });
  });

  function pdfAssetIdFromBody(body: string): string | null {
    const trimmed = body.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('asset_')) return trimmed;
    try {
      const parsed = JSON.parse(trimmed) as { pdfAssetId?: unknown };
      return typeof parsed.pdfAssetId === 'string' ? parsed.pdfAssetId : null;
    } catch {
      return null;
    }
  }

  function bumpRenderVersion() {
    renderVersionCounter += 1;
    renderVersion = renderVersionCounter;
  }

  function clampZoom(value: number): number {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  }

  function strokePointsAttr(points: PdfStrokePoint[]): string {
    return points.map((point) => `${point.x},${point.y}`).join(' ');
  }

  function strokeBounds(points: PdfStrokePoint[], padding = 0): PdfRect {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    if (!Number.isFinite(minX)) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    return {
      x: minX - padding,
      y: minY - padding,
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2
    };
  }

  function cloneSignatureSnapshot(
    signature: PdfSignatureSnapshot
  ): PdfSignatureSnapshot {
    return {
      id: signature.id,
      width: signature.width,
      height: signature.height,
      strokes: signature.strokes.map((stroke) => ({
        id: stroke.id,
        color: stroke.color,
        width: stroke.width,
        points: stroke.points.map((point) => ({ ...point }))
      }))
    };
  }

  function loadReusableSignatures(): PdfSignatureSnapshot[] {
    try {
      const raw = localStorage.getItem(SIGNATURE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PdfSignatureSnapshot[];
        if (Array.isArray(parsed)) {
          return parsed
            .filter(
              (sig) => Array.isArray(sig?.strokes) && sig.strokes.length > 0
            )
            .map((sig) => ({ ...sig, id: sig.id ?? crypto.randomUUID() }));
        }
      }
      const legacy = localStorage.getItem(LEGACY_SIGNATURE_STORAGE_KEY);
      if (legacy) {
        const parsed = JSON.parse(legacy) as PdfSignatureSnapshot;
        if (Array.isArray(parsed?.strokes) && parsed.strokes.length > 0) {
          const migrated: PdfSignatureSnapshot[] = [
            { ...parsed, id: crypto.randomUUID() }
          ];
          localStorage.setItem(SIGNATURE_STORAGE_KEY, JSON.stringify(migrated));
          localStorage.removeItem(LEGACY_SIGNATURE_STORAGE_KEY);
          return migrated;
        }
      }
      return [];
    } catch {
      return [];
    }
  }

  function persistSignatures() {
    localStorage.setItem(SIGNATURE_STORAGE_KEY, JSON.stringify(savedSignatures));
  }

  function appendSignature(signature: PdfSignatureSnapshot) {
    savedSignatures = [...savedSignatures, signature];
    activeSignatureId = signature.id;
    persistSignatures();
  }

  function deleteSignature(id: string) {
    savedSignatures = savedSignatures.filter((sig) => sig.id !== id);
    persistSignatures();
    if (activeSignatureId === id) {
      activeSignatureId = savedSignatures[0]?.id ?? null;
    }
    if (savedSignatures.length === 0) {
      signaturePickerOpen = false;
      if (activeTool === 'signature') activeTool = 'select';
    }
  }

  function selectSignature(id: string) {
    activeSignatureId = id;
    signaturePickerOpen = false;
  }

  function getActiveSignature(): PdfSignatureSnapshot | null {
    if (savedSignatures.length === 0) return null;
    return (
      savedSignatures.find((sig) => sig.id === activeSignatureId) ??
      savedSignatures[0]
    );
  }

  function openSignaturePad() {
    signaturePickerOpen = false;
    signaturePadDraft = null;
    signaturePadStrokes = [];
    signatureDialogOpen = true;
  }

  function createAnnotation(
    type: PdfAnnotationType,
    pageIndex: number,
    rect: PdfRect,
    body?: string,
    extras: Partial<Pick<PdfAnnotation, 'strokes' | 'signature'>> = {}
  ) {
    if (!annotationsMap || isTrashed) return;
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    annotationsMap.set(id, {
      id,
      type,
      pageIndex,
      rects: [rect],
      color:
        type === 'highlight'
          ? HIGHLIGHT_COLOR
          : type === 'comment'
            ? COMMENT_COLOR
            : type === 'ink'
              ? INK_COLOR
              : SIGNATURE_COLOR,
      opacity: type === 'highlight' ? 0.32 : type === 'comment' ? 0.18 : 1,
      authorId: 'local',
      createdAt: now,
      updatedAt: now,
      body,
      ...extras
    });
    selectedAnnotationId = id;
    if (type === 'comment') commentsSidebarOpen = true;
  }

  function isCommentLikeAnnotation(annotation: PdfAnnotation): boolean {
    return (
      annotation.type === 'comment' ||
      (annotation.type === 'highlight' && Boolean(annotation.body?.trim()))
    );
  }

  function deleteAnnotation(id: string) {
    if (isTrashed) return;
    annotationsMap?.delete(id);
    if (selectedAnnotationId === id) selectedAnnotationId = null;
  }

  function updateAnnotation(id: string, patch: Partial<PdfAnnotation>) {
    if (isTrashed || !annotationsMap) return;
    const existing = annotationsMap.get(id);
    if (!existing) return;
    annotationsMap.set(id, {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString()
    });
  }

  function selectAnnotation(id: string | null) {
    selectedAnnotationId = id;
    const annotation = id ? annotationsMap?.get(id) : null;
    if (annotation && isCommentLikeAnnotation(annotation)) {
      commentsSidebarOpen = true;
    }
  }

  function jumpToAnnotation(id: string) {
    selectAnnotation(id);
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-annotation-id="${CSS.escape(id)}"]`
      );
      target?.scrollIntoView({
        block: 'center',
        inline: 'center',
        behavior: 'smooth'
      });
    });
  }

  function syncAnnotationsFromYDoc() {
    annotations = Array.from(annotationsMap?.values() ?? []).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    );
    annotationVersion += 1;
  }

  function scheduleSave() {
    if (isTrashed || !saveReady) return;
    savingState = 'pending';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void flushSave();
    }, SAVE_DEBOUNCE_MS);
  }

  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const doc = yDoc;
    if (!doc) return;
    try {
      savingState = 'saving';
      const yrsState = Array.from(Y.encodeStateAsUpdate(doc));
      await apiSaveNote({ id: noteId, yrs_state: yrsState });
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
      console.error('[PdfNoteViewer] save failed', err);
    }
  }

  function sanitizeFilename(name: string): string {
    // Strip the characters Windows / macOS refuse, collapse whitespace,
    // and fall back to a sensible default so the <a download> attribute
    // never resolves to an empty string.
    const cleaned = name
      .replace(/[\\/:*?"<>|]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned.slice(0, 120) || 'pdf-note';
  }

  async function downloadAnnotatedPdf() {
    if (exportInProgress) return;
    if (!pdfDoc) return;
    exportInProgress = true;
    exportError = null;
    try {
      // getData() returns the original bytes the document was opened from
      // — we never serialise pdf.js's parsed representation back to disk,
      // so the result here is byte-identical to the source asset.
      const sourceBytes = await pdfDoc.getData();
      const out = await exportAnnotatedPdf(
        sourceBytes,
        annotations.filter((annotation) => !annotation.deletedAt)
      );
      const title = tree.notesById[noteId]?.title ?? 'pdf-note';
      // Bridge handles the platform split: native save dialog in Tauri,
      // <a download> fallback in the browser. Returns false if the user
      // cancelled the dialog — leave the toolbar quiet in that case.
      await saveAnnotatedPdf({
        suggestedName: `${sanitizeFilename(title)}.pdf`,
        bytes: out
      });
    } catch (err) {
      exportError = err instanceof Error ? err.message : String(err);
      console.error('[PdfNoteViewer] export failed', err);
    } finally {
      exportInProgress = false;
    }
  }

  function setTool(tool: PdfTool) {
    if (tool === 'signature') {
      if (savedSignatures.length === 0) {
        openSignaturePad();
        return;
      }
      if (activeTool === 'signature') {
        signaturePickerOpen = !signaturePickerOpen;
        signaturePickerRectVersion += 1;
        return;
      }
      if (!activeSignatureId) activeSignatureId = savedSignatures[0].id;
      activeTool = 'signature';
      return;
    }
    signaturePickerOpen = false;
    activeTool = activeTool === tool && tool !== 'select' ? 'select' : tool;
  }

  function signaturePadPoint(event: PointerEvent): PdfStrokePoint {
    const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    const x =
      ((event.clientX - rect.left) / Math.max(1, rect.width)) *
      SIGNATURE_PAD_WIDTH;
    const y =
      ((event.clientY - rect.top) / Math.max(1, rect.height)) *
      SIGNATURE_PAD_HEIGHT;
    return {
      x: Math.min(SIGNATURE_PAD_WIDTH, Math.max(0, x)),
      y: Math.min(SIGNATURE_PAD_HEIGHT, Math.max(0, y)),
      pressure: event.pressure || 1
    };
  }

  function pushSignaturePadPoint(event: PointerEvent) {
    if (!signaturePadDraft) return;
    const point = signaturePadPoint(event);
    const previous =
      signaturePadDraft.points[signaturePadDraft.points.length - 1];
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 1.5) {
      return;
    }
    signaturePadDraft = {
      ...signaturePadDraft,
      points: [...signaturePadDraft.points, point]
    };
  }

  function beginSignaturePadStroke(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
    signaturePadDraft = {
      id: crypto.randomUUID(),
      points: [signaturePadPoint(event)],
      color: SIGNATURE_COLOR,
      width: 3.5
    };
  }

  function finishSignaturePadStroke(event: PointerEvent) {
    if (!signaturePadDraft) return;
    pushSignaturePadPoint(event);
    const draft = signaturePadDraft;
    signaturePadDraft = null;
    if (draft.points.length < 2) return;
    signaturePadStrokes = [...signaturePadStrokes, draft];
  }

  function clearSignaturePad() {
    signaturePadDraft = null;
    signaturePadStrokes = [];
  }

  function closeSignatureDialog() {
    signatureDialogOpen = false;
    signaturePadDraft = null;
    signaturePadStrokes = [];
    if (savedSignatures.length === 0) activeTool = 'select';
  }

  function saveSignatureFromPad() {
    if (signaturePadStrokes.length === 0) return;
    const signature: PdfSignatureSnapshot = {
      id: crypto.randomUUID(),
      width: SIGNATURE_PAD_WIDTH,
      height: SIGNATURE_PAD_HEIGHT,
      strokes: signaturePadStrokes.map((stroke) => ({
        ...stroke,
        points: stroke.points.map((point) => ({ ...point }))
      }))
    };
    appendSignature(signature);
    signatureDialogOpen = false;
    signaturePadDraft = null;
    signaturePadStrokes = [];
    activeTool = 'signature';
  }

  const fitWidthZoom = $derived.by(() => {
    if (!container || firstPageWidth <= 0) return 1;
    return clampZoom((container.clientWidth - 32) / firstPageWidth);
  });

  const effectiveZoom = $derived(zoomMode === 'fit-width' ? fitWidthZoom : zoom);
  const zoomLabel = $derived(`${Math.round(effectiveZoom * 100)}%`);
  const commentAnnotations = $derived(
    annotations.filter((annotation) => isCommentLikeAnnotation(annotation))
  );
  const menuRect = $derived.by(() => {
    void menuRectVersion;
    return zoomButton?.getBoundingClientRect() ?? null;
  });
  const menuLeft = $derived.by(() => {
    if (!menuRect || typeof window === 'undefined') return 0;
    const width = 160;
    return Math.max(8, Math.min(menuRect.left, window.innerWidth - width - 8));
  });
  const menuTop = $derived(menuRect ? menuRect.bottom : 0);
  const signatureMenuRect = $derived.by(() => {
    void signaturePickerRectVersion;
    return signatureButton?.getBoundingClientRect() ?? null;
  });
  const signatureMenuLeft = $derived.by(() => {
    if (!signatureMenuRect || typeof window === 'undefined') return 0;
    return Math.max(
      8,
      Math.min(
        signatureMenuRect.left,
        window.innerWidth - SIGNATURE_MENU_WIDTH - 8
      )
    );
  });
  const signatureMenuTop = $derived(
    signatureMenuRect ? signatureMenuRect.bottom : 0
  );

  function setFixedZoom(value: number) {
    zoomMode = 'fixed';
    zoom = clampZoom(value);
    zoomMenuOpen = false;
  }

  function setFitWidthZoom() {
    zoomMode = 'fit-width';
    zoomMenuOpen = false;
  }

  function zoomBy(factor: number) {
    setFixedZoom(effectiveZoom * factor);
  }

  function toggleZoomMenu() {
    zoomMenuOpen = !zoomMenuOpen;
    menuRectVersion += 1;
  }

  async function zoomFromWheel(deltaY: number, clientX: number, clientY: number) {
    if (!container) return;
    const previous = effectiveZoom;
    const next = clampZoom(previous * Math.exp(-deltaY * 0.001));
    if (Math.abs(next - previous) < 0.001) return;

    const rect = container.getBoundingClientRect();
    const offsetX = clientX - rect.left;
    const offsetY = clientY - rect.top;
    const xRatio = (container.scrollLeft + offsetX) / Math.max(1, container.scrollWidth);
    const yRatio = (container.scrollTop + offsetY) / Math.max(1, container.scrollHeight);

    zoomMode = 'fixed';
    zoom = next;
    await tick();
    requestAnimationFrame(() => {
      if (!container) return;
      container.scrollLeft = xRatio * container.scrollWidth - offsetX;
      container.scrollTop = yRatio * container.scrollHeight - offsetY;
    });
  }

  function ctrlWheelZoom(node: HTMLElement) {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      void zoomFromWheel(e.deltaY, e.clientX, e.clientY);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return {
      destroy() {
        node.removeEventListener('wheel', onWheel);
      }
    };
  }

  $effect(() => {
    if (!container) return;
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => {
      menuRectVersion += 1;
      bumpRenderVersion();
    });
    resizeObserver.observe(container);
  });

  $effect(() => {
    if (!zoomMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (zoomMenuEl?.contains(target)) return;
      if (zoomButton?.contains(target)) return;
      zoomMenuOpen = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') zoomMenuOpen = false;
    };
    const onResize = () => {
      menuRectVersion += 1;
    };
    queueMicrotask(() => window.addEventListener('pointerdown', onPointerDown));
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('scroll', onResize);

    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onResize);
    };
  });

  $effect(() => {
    if (!signaturePickerOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (signaturePickerEl?.contains(target)) return;
      if (signatureButton?.contains(target)) return;
      signaturePickerOpen = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') signaturePickerOpen = false;
    };
    const onResize = () => {
      signaturePickerRectVersion += 1;
    };
    queueMicrotask(() => window.addEventListener('pointerdown', onPointerDown));
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('scroll', onResize);

    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onResize);
    };
  });

  $effect(() => {
    void zoom;
    void zoomMode;
    bumpRenderVersion();
  });

  // Re-init the live-collab provider once the note becomes joinable.
  // Same pattern as NoteEditor: until the first push lands the note has
  // no UID/key, so noteRoomInfo returns null. The flag-gating prevents
  // tearing down and reconnecting on every save once the note is pushed.
  $effect(() => {
    const pushed = tree.notesById[noteId]?.pushed ?? false;
    if (!collabReady) return;
    if (pushed === lastSeenPushed) return;
    lastSeenPushed = pushed;
    void setupCollabProvider();
  });

  // Publish PDF-specific awareness so peers know which page each user is
  // on, which tool they have active, and which annotation they have
  // selected. setLocalStateField is debounced internally by Awareness,
  // so three calls per change are fine.
  $effect(() => {
    if (!awareness) return;
    awareness.setLocalStateField('tool', activeTool);
  });
  $effect(() => {
    if (!awareness) return;
    awareness.setLocalStateField('pageIndex', Math.max(0, activePageNumber - 1));
  });
  $effect(() => {
    if (!awareness) return;
    awareness.setLocalStateField('selection', selectedAnnotationId);
  });

  /**
   * (Re)create the live-collab provider for this PDF note. Mirrors
   * NoteEditor.setupCollabProvider — same prerequisites (relay URL
   * configured, etebase session, note has been pushed at least once)
   * and the same per-note encryption key sourced from the Rust side
   * via noteRoomInfo.
   */
  async function setupCollabProvider() {
    if (provider) {
      provider.destroy();
      provider = null;
      collabOnline = false;
    }
    collabConfigured = false;

    const collabUrl = (
      (getSettingValue('account.collabServerUrl') as string | undefined) ?? ''
    ).trim();
    if (!collabUrl) return;
    if (!yDoc || !awareness) return;

    try {
      const room = await noteRoomInfo(noteId);
      if (!room) return;
      collabConfigured = true;
      provider = new CollabProvider({
        url: collabUrl,
        roomId: room.room_id,
        keyBytes: base64ToBytes(room.key_b64),
        doc: yDoc,
        awareness,
        onStatusChange: (online) => {
          collabOnline = online;
        }
      });
    } catch (err) {
      console.debug('[PdfNoteViewer] collab provider init failed', err);
    }
  }

  // Track which page the user is most likely looking at via
  // IntersectionObserver. Used as the awareness `pageIndex` so peers can
  // see what other peers are reading. Re-runs whenever pageNumbers
  // changes (i.e. once the PDF loads) to start observing fresh DOM nodes.
  $effect(() => {
    if (!container || pageNumbers.length === 0) return;
    pageIntersectionObserver?.disconnect();
    pageVisibility.clear();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageAttr = (entry.target as HTMLElement).dataset.pageNumber;
          const pageNum = pageAttr ? Number(pageAttr) : NaN;
          if (!Number.isFinite(pageNum)) continue;
          if (entry.intersectionRatio > 0) {
            pageVisibility.set(pageNum, entry.intersectionRatio);
          } else {
            pageVisibility.delete(pageNum);
          }
        }
        // Pick the most-visible page; ties go to the smaller page number
        // so scrolling down advances the indicator predictably.
        let best = activePageNumber;
        let bestRatio = -1;
        for (const [page, ratio] of pageVisibility) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            best = page;
          }
        }
        if (best !== activePageNumber) activePageNumber = best;
      },
      {
        root: container,
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 1]
      }
    );
    pageIntersectionObserver = observer;
    // Observe after DOM updates so all page wrappers exist.
    void tick().then(() => {
      const targets = container?.querySelectorAll<HTMLElement>(
        '[data-page-number]'
      );
      targets?.forEach((el) => observer.observe(el));
    });
    return () => {
      observer.disconnect();
      pageIntersectionObserver = null;
      pageVisibility.clear();
    };
  });

  onMount(async () => {
    savedSignatures = loadReusableSignatures();
    activeSignatureId = savedSignatures[0]?.id ?? null;
    try {
      const note = await loadNote(noteId);
      isTrashed = note.trashed;

      const localYDoc = new Y.Doc();
      yDoc = localYDoc;
      if (note.yrs_state.length > 0) {
        try {
          Y.applyUpdate(localYDoc, new Uint8Array(note.yrs_state));
        } catch (err) {
          console.warn('[PdfNoteViewer] yrs_state hydration failed', err);
        }
      }
      annotationsMap = localYDoc.getMap<PdfAnnotation>(PDF_ANNOTATIONS_MAP);
      syncAnnotationsFromYDoc();
      yDocUpdateHandler = () => {
        syncAnnotationsFromYDoc();
        scheduleSave();
      };
      localYDoc.on('update', yDocUpdateHandler);

      // Awareness goes alongside the Y.Doc — the CollabProvider takes
      // both as constructor args. Seed the local user field now so peers
      // see our name + colour as soon as we join the room.
      const localAwareness = new Awareness(localYDoc);
      awareness = localAwareness;
      try {
        const session = await etebaseSession();
        const userName = session?.username ?? 'You';
        localAwareness.setLocalStateField('user', {
          name: userName,
          color: pickCursorColor(userName)
        });
      } catch (err) {
        console.debug('[PdfNoteViewer] no session for awareness', err);
      }

      const assetId = pdfAssetIdFromBody(note.body);
      if (!assetId) throw new Error('PDF asset is missing.');

      const asset = await fetchDrawingAsset(assetId);
      if (asset.mime_type !== 'application/pdf') {
        throw new Error('Stored file is not a PDF.');
      }

      const pdfjs = await import('pdfjs-dist');
      const pdfViewer = await import('pdfjs-dist/web/pdf_viewer.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      pdfjsLib = pdfjs;
      pdfViewerLib = pdfViewer;
      const task = pdfjs.getDocument({ data: new Uint8Array(asset.bytes) });
      pdfDoc = await task.promise;
      const firstPage = await pdfDoc.getPage(1);
      firstPageWidth = firstPage.getViewport({ scale: 1 }).width;
      pageNumbers = Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1);
      loading = false;
      savingState = 'saved';
      saveReady = true;
      await tick();
      bumpRenderVersion();

      void listen('sync-completed', async (payload) => {
        if (!payload.notes_pulled_ids.includes(noteId) || !yDoc) return;
        try {
          const fresh = await loadNote(noteId);
          if (yDoc && fresh.yrs_state.length > 0) {
            Y.applyUpdate(yDoc, new Uint8Array(fresh.yrs_state));
          }
        } catch (err) {
          console.warn('[PdfNoteViewer] sync-completed merge failed', err);
        }
      }).then((unlisten) => {
        unsubSync = unlisten;
      });

      // Capture the initial pushed state, set up the provider once, then
      // let the $effect react only to subsequent transitions.
      lastSeenPushed = tree.notesById[noteId]?.pushed ?? false;
      await setupCollabProvider();
      collabReady = true;

      unsubSession = onSessionChange(() => {
        void setupCollabProvider();
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      loading = false;
    }
  });

  onDestroy(() => {
    if (saveTimer) {
      void flushSave();
    }
    saveReady = false;
    unsubSync?.();
    unsubSync = null;
    unsubSession?.();
    unsubSession = null;
    resizeObserver?.disconnect();
    pageIntersectionObserver?.disconnect();
    pageIntersectionObserver = null;
    pageVisibility.clear();
    void pdfDoc?.cleanup();
    if (yDoc && yDocUpdateHandler) {
      yDoc.off('update', yDocUpdateHandler);
    }
    yDocUpdateHandler = null;
    // CollabProvider must be torn down before awareness/yDoc so its
    // destroy() can broadcast the null-state cleanup frame to peers.
    provider?.destroy();
    provider = null;
    collabOnline = false;
    collabConfigured = false;
    awareness?.destroy();
    awareness = null;
    yDoc?.destroy();
    yDoc = null;
    annotationsMap = null;
    clearNoteStatus(noteId);
  });

  function renderPage(pageSurface: HTMLDivElement, params: RenderParams) {
    let current = params;
    let cancelled = false;
    let drawGeneration = 0;
    let pageView: PdfPageView | null = null;
    let currentViewport:
      | ReturnType<Awaited<ReturnType<PdfDocument['getPage']>>['getViewport']>
      | null = null;

    function renderAppAnnotations() {
      const pageEl = pageSurface.querySelector<HTMLElement>('.page');
      const viewport = currentViewport;
      if (!pageEl || !viewport) return;

      pageEl.querySelector('.pdf-app-annotation-layer')?.remove();
      const layer = document.createElement('div');
      layer.className = 'pdf-app-annotation-layer';
      layer.style.pointerEvents =
        current.activeTool === 'select' || isTrashed ? 'none' : 'auto';
      pageEl.append(layer);

      const pageAnnotations = annotations.filter(
        (annotation) => annotation.pageIndex === current.pageNumber - 1
      );
      for (const annotation of pageAnnotations) {
        for (const rect of annotation.rects) {
          const [x1, y1] = viewport.convertToViewportPoint(rect.x, rect.y);
          const [x2, y2] = viewport.convertToViewportPoint(
            rect.x + rect.width,
            rect.y + rect.height
          );
          const left = Math.min(x1, x2);
          const top = Math.min(y1, y2);
          const width = Math.abs(x2 - x1);
          const height = Math.abs(y2 - y1);
          const node = document.createElement('div');
          node.className = `pdf-app-annotation pdf-app-annotation-${annotation.type}`;
          if (annotation.id === current.selectedAnnotationId) {
            node.classList.add('pdf-app-annotation-selected');
          }
          if (annotation.resolved) {
            node.classList.add('pdf-app-annotation-resolved');
          }
          node.dataset.annotationId = annotation.id;
          node.style.left = `${left}px`;
          node.style.top = `${top}px`;
          node.style.width = `${width}px`;
          node.style.height = `${height}px`;
          node.style.setProperty('--annotation-color', annotation.color);
          node.style.setProperty('--annotation-opacity', `${annotation.opacity}`);
          if (annotation.body) node.title = annotation.body;
          if (annotation.type === 'signature' && annotation.signature) {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute(
              'viewBox',
              `0 0 ${annotation.signature.width} ${annotation.signature.height}`
            );
            svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            svg.classList.add('pdf-app-stroke-svg');
            for (const stroke of annotation.signature.strokes) {
              const polyline = document.createElementNS(
                'http://www.w3.org/2000/svg',
                'polyline'
              );
              polyline.setAttribute('points', strokePointsAttr(stroke.points));
              polyline.setAttribute('fill', 'none');
              polyline.setAttribute('stroke', stroke.color);
              polyline.setAttribute('stroke-width', `${stroke.width}`);
              polyline.setAttribute('stroke-linecap', 'round');
              polyline.setAttribute('stroke-linejoin', 'round');
              svg.append(polyline);
            }
            node.append(svg);
          } else if (annotation.type === 'ink' && annotation.strokes) {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
            svg.classList.add('pdf-app-stroke-svg');
            for (const stroke of annotation.strokes) {
              const polyline = document.createElementNS(
                'http://www.w3.org/2000/svg',
                'polyline'
              );
              const points = stroke.points
                .map((point) => {
                  const [pointX, pointY] = viewport.convertToViewportPoint(
                    point.x,
                    point.y
                  );
                  return `${pointX - left},${pointY - top}`;
                })
                .join(' ');
              polyline.setAttribute('points', points);
              polyline.setAttribute('fill', 'none');
              polyline.setAttribute('stroke', stroke.color);
              polyline.setAttribute('stroke-width', `${stroke.width * viewport.scale}`);
              polyline.setAttribute('stroke-linecap', 'round');
              polyline.setAttribute('stroke-linejoin', 'round');
              svg.append(polyline);
            }
            node.append(svg);
          }
          if (current.activeTool === 'delete') {
            node.addEventListener('pointerdown', (event) => {
              event.preventDefault();
              event.stopPropagation();
              deleteAnnotation(annotation.id);
            });
          } else {
            node.addEventListener('pointerdown', (event) => {
              event.preventDefault();
              event.stopPropagation();
              selectAnnotation(annotation.id);
            });
          }
          layer.append(node);
        }
      }

      if (current.activeTool === 'pen') {
        layer.addEventListener('pointerdown', (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const pageRect = pageEl.getBoundingClientRect();
          const preview = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'svg'
          );
          preview.setAttribute('viewBox', `0 0 ${pageRect.width} ${pageRect.height}`);
          preview.classList.add('pdf-app-ink-preview');
          const previewStroke = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'polyline'
          );
          previewStroke.setAttribute('fill', 'none');
          previewStroke.setAttribute('stroke', INK_COLOR);
          previewStroke.setAttribute('stroke-width', `${INK_WIDTH * viewport.scale}`);
          previewStroke.setAttribute('stroke-linecap', 'round');
          previewStroke.setAttribute('stroke-linejoin', 'round');
          preview.append(previewStroke);
          layer.append(preview);

          const pdfPoints: PdfStrokePoint[] = [];
          const viewportPoints: PdfStrokePoint[] = [];
          const pushPoint = (clientX: number, clientY: number) => {
            const x = clientX - pageRect.left;
            const y = clientY - pageRect.top;
            const previous = viewportPoints[viewportPoints.length - 1];
            if (previous && Math.hypot(x - previous.x, y - previous.y) < 1.5) {
              return;
            }
            const [pdfX, pdfY] = viewport.convertToPdfPoint(x, y);
            pdfPoints.push({ x: pdfX, y: pdfY });
            viewportPoints.push({ x, y });
            previewStroke.setAttribute('points', strokePointsAttr(viewportPoints));
          };

          pushPoint(event.clientX, event.clientY);

          const onMove = (moveEvent: PointerEvent) => {
            pushPoint(moveEvent.clientX, moveEvent.clientY);
          };
          const onUp = (upEvent: PointerEvent) => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            pushPoint(upEvent.clientX, upEvent.clientY);
            preview.remove();
            if (pdfPoints.length < 2) return;
            const rect = strokeBounds(pdfPoints, INK_WIDTH * 2);
            if (rect.width < 1 || rect.height < 1) return;
            createAnnotation(
              'ink',
              current.pageNumber - 1,
              rect,
              undefined,
              {
                strokes: [
                  {
                    id: crypto.randomUUID(),
                    points: pdfPoints,
                    color: INK_COLOR,
                    width: INK_WIDTH
                  }
                ]
              }
            );
          };

          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp, { once: true });
        });
        return;
      }

      if (
        current.activeTool !== 'highlight' &&
        current.activeTool !== 'comment' &&
        current.activeTool !== 'signature'
      ) {
        return;
      }

      layer.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        if (current.activeTool === 'signature' && savedSignatures.length === 0) {
          openSignaturePad();
          activeTool = 'select';
          return;
        }
        const pageRect = pageEl.getBoundingClientRect();
        const startX = event.clientX - pageRect.left;
        const startY = event.clientY - pageRect.top;
        const [pdfStartX, pdfStartY] = viewport.convertToPdfPoint(
          startX,
          startY
        );
        const preview = document.createElement('div');
        preview.className = `pdf-app-annotation pdf-app-annotation-preview pdf-app-annotation-${current.activeTool}`;
        layer.append(preview);

        const updatePreview = (clientX: number, clientY: number) => {
          const x = clientX - pageRect.left;
          const y = clientY - pageRect.top;
          preview.style.left = `${Math.min(startX, x)}px`;
          preview.style.top = `${Math.min(startY, y)}px`;
          preview.style.width = `${Math.abs(x - startX)}px`;
          preview.style.height = `${Math.abs(y - startY)}px`;
        };

        const onMove = (moveEvent: PointerEvent) => {
          updatePreview(moveEvent.clientX, moveEvent.clientY);
        };
        const onUp = (upEvent: PointerEvent) => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          preview.remove();

          const endX = upEvent.clientX - pageRect.left;
          const endY = upEvent.clientY - pageRect.top;
          const [pdfEndX, pdfEndY] = viewport.convertToPdfPoint(endX, endY);
          let rect: PdfRect = {
            x: Math.min(pdfStartX, pdfEndX),
            y: Math.min(pdfStartY, pdfEndY),
            width: Math.abs(pdfEndX - pdfStartX),
            height: Math.abs(pdfEndY - pdfStartY)
          };

          if (
            current.activeTool === 'comment' &&
            (rect.width < 4 || rect.height < 4)
          ) {
            rect = {
              x: pdfStartX,
              y: pdfStartY - 36,
              width: 96,
              height: 36
            };
          }
          if (
            current.activeTool === 'signature' &&
            (rect.width < 4 || rect.height < 4)
          ) {
            rect = {
              x: pdfStartX,
              y: pdfStartY - 48,
              width: 180,
              height: 48
            };
          }
          if (rect.width < 4 || rect.height < 4) return;

          const annotationType: PdfAnnotationType =
            current.activeTool === 'comment'
              ? 'comment'
              : current.activeTool === 'signature'
                ? 'signature'
                : 'highlight';
          const body =
            annotationType === 'comment'
              ? window.prompt('Comment')?.trim()
              : undefined;
          const activeSignature =
            annotationType === 'signature' ? getActiveSignature() : null;
          const signature =
            annotationType === 'signature' && activeSignature
              ? cloneSignatureSnapshot(activeSignature)
              : undefined;
          if (annotationType === 'signature' && !signature) return;
          createAnnotation(
            annotationType,
            current.pageNumber - 1,
            rect,
            body || undefined,
            signature ? { signature } : {}
          );
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
      });
    }

    async function draw() {
      const generation = ++drawGeneration;
      const request = { ...current };
      const doc = pdfDoc;
      const pdfjs = pdfjsLib;
      const pdfViewer = pdfViewerLib;
      const renderContainer = container;
      if (!doc || !pdfjs || !pdfViewer || !renderContainer) return;
      pageView?.cancelRendering();
      pageView?.destroy();
      pageView = null;
      pageSurface.replaceChildren();

      const page = await doc.getPage(request.pageNumber);
      if (cancelled || generation !== drawGeneration) return;

      const baseViewport = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(280, renderContainer.clientWidth - 32);
      const fitScale = clampZoom(availableWidth / baseViewport.width);
      const requestedScale =
        request.zoomMode === 'fit-width' ? fitScale : clampZoom(request.zoom);
      const viewerScale = requestedScale / PDF_TO_CSS_UNITS;
      const viewport = page.getViewport({ scale: requestedScale });
      currentViewport = viewport;

      if (cancelled || generation !== drawGeneration) return;
      const eventBus = new pdfViewer.EventBus();
      pageView = new pdfViewer.PDFPageView({
        container: pageSurface,
        eventBus,
        id: request.pageNumber,
        scale: viewerScale,
        defaultViewport: viewport,
        annotationMode: pdfjs.AnnotationMode.DISABLE,
        maxCanvasPixels: -1,
        maxCanvasDim: -1,
        enableDetailCanvas: true,
        enableOptimizedPartialRendering: true,
        enableSelectionRendering: true
      });
      pageView.setPdfPage(page);
      try {
        await pageView.draw();
        if (cancelled || generation !== drawGeneration) return;
        renderAppAnnotations();
      } catch (err) {
        if ((err as { name?: string })?.name !== 'RenderingCancelledException') {
          console.warn('[PdfNoteViewer] page render failed', err);
        }
      }
    }

    void draw();
    return {
      update(next: RenderParams) {
        const shouldRedraw =
          next.pageNumber !== current.pageNumber ||
          next.version !== current.version ||
          next.zoom !== current.zoom ||
          next.zoomMode !== current.zoomMode;
        current = next;
        if (shouldRedraw) {
          void draw();
        } else {
          renderAppAnnotations();
        }
      },
      destroy() {
        cancelled = true;
        drawGeneration += 1;
        pageView?.cancelRendering();
        pageView?.destroy();
      }
    };
  }
</script>

<div class="flex h-full w-full flex-col bg-background">
  {#if loading}
    <div class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 class="size-4 animate-spin" aria-hidden="true" />
      <span>Loading PDF…</span>
    </div>
  {:else if error}
    <div class="flex h-full items-center justify-center gap-2 p-6 text-sm text-destructive">
      <AlertCircle class="size-4 shrink-0" aria-hidden="true" />
      <span>{error}</span>
    </div>
  {:else}
    <div
      class="shrink-0 border-b border-border bg-background"
      role="toolbar"
      aria-label="PDF controls"
    >
      <div class="flex h-9 items-center justify-between gap-2 pl-2">
        <div class="flex items-center gap-1">
          <div class="inline-flex items-center rounded-md border border-border bg-background p-0.5">
            <Button
              variant={activeTool === 'select' ? 'secondary' : 'ghost'}
              size="icon"
              class="size-7"
              onclick={() => setTool('select')}
              aria-label="Select"
              title="Select"
              aria-pressed={activeTool === 'select'}
            >
              <MousePointer2 class="size-3.5" aria-hidden="true" />
            </Button>

            <Button
              variant={activeTool === 'highlight' ? 'secondary' : 'ghost'}
              size="icon"
              class="size-7"
              onclick={() => setTool('highlight')}
              aria-label="Highlight"
              title="Highlight"
              aria-pressed={activeTool === 'highlight'}
              disabled={isTrashed}
            >
              <Highlighter class="size-3.5" aria-hidden="true" />
            </Button>

            <Button
              variant={activeTool === 'comment' ? 'secondary' : 'ghost'}
              size="icon"
              class="size-7"
              onclick={() => setTool('comment')}
              aria-label="Comment"
              title="Comment"
              aria-pressed={activeTool === 'comment'}
              disabled={isTrashed}
            >
              <MessageSquarePlus class="size-3.5" aria-hidden="true" />
            </Button>

            <Button
              variant={activeTool === 'pen' ? 'secondary' : 'ghost'}
              size="icon"
              class="size-7"
              onclick={() => setTool('pen')}
              aria-label="Pen"
              title="Pen"
              aria-pressed={activeTool === 'pen'}
              disabled={isTrashed}
            >
              <PenLine class="size-3.5" aria-hidden="true" />
            </Button>

            <Button
              bind:ref={signatureButton}
              variant={activeTool === 'signature' ? 'secondary' : 'ghost'}
              size="icon"
              class="size-7"
              onclick={() => setTool('signature')}
              aria-label="Sign"
              title="Sign"
              aria-pressed={activeTool === 'signature'}
              aria-haspopup="menu"
              aria-expanded={signaturePickerOpen}
              disabled={isTrashed}
            >
              <Signature class="size-3.5" aria-hidden="true" />
            </Button>

            <Button
              variant={activeTool === 'delete' ? 'secondary' : 'ghost'}
              size="icon"
              class="size-7"
              onclick={() => setTool('delete')}
              aria-label="Delete annotation"
              title="Delete annotation"
              aria-pressed={activeTool === 'delete'}
              disabled={isTrashed}
            >
              <Trash2 class="size-3.5" aria-hidden="true" />
            </Button>
          </div>

          <Button
            variant={commentsSidebarOpen ? 'secondary' : 'ghost'}
            size="icon"
            class="size-7"
            onclick={() => (commentsSidebarOpen = !commentsSidebarOpen)}
            aria-label="Toggle comments"
            title="Toggle comments"
            aria-pressed={commentsSidebarOpen}
          >
            <MessagesSquare class="size-3.5" aria-hidden="true" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            class="size-7"
            onclick={() => void downloadAnnotatedPdf()}
            aria-label={tUi('pdf.export.label')}
            title={exportError
              ? `${tUi('pdf.export.failed')}: ${exportError}`
              : tUi('pdf.export.label')}
            disabled={exportInProgress || !pdfDoc}
          >
            {#if exportInProgress}
              <Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
            {:else}
              <Download class="size-3.5" aria-hidden="true" />
            {/if}
          </Button>
        </div>

        <div class="inline-flex items-center rounded-md border border-border bg-background p-0.5">
          <Button
            variant="ghost"
            size="icon"
            class="size-7"
            onclick={() => zoomBy(1 / ZOOM_STEP)}
            aria-label="Zoom out"
            title="Zoom out"
          >
            <Minus class="size-3.5" aria-hidden="true" />
          </Button>

          <button
            bind:this={zoomButton}
            type="button"
            class="flex h-7 min-w-22 items-center justify-center gap-1 rounded-sm px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            onclick={toggleZoomMenu}
            aria-haspopup="menu"
            aria-expanded={zoomMenuOpen}
            title="Choose zoom"
          >
            <span>{zoomLabel}</span>
            <ChevronDown class="size-3" aria-hidden="true" />
          </button>

          <Button
            variant="ghost"
            size="icon"
            class="size-7"
            onclick={() => zoomBy(ZOOM_STEP)}
            aria-label="Zoom in"
            title="Zoom in"
          >
            <Plus class="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>

    <div class="flex min-h-0 flex-1 overflow-hidden">
      <div
        bind:this={container}
        use:ctrlWheelZoom
        class="themed-scrollbar min-h-0 flex-1 overflow-auto px-3 py-4"
      >
        <div class="mx-auto flex min-w-full w-max flex-col items-center gap-4">
          {#each pageNumbers as pageNumber (pageNumber)}
            <figure
              class="flex w-max flex-col items-center gap-1"
              data-page-number={pageNumber}
            >
              <div
                use:renderPage={{
                  pageNumber,
                  version: renderVersion,
                  zoom,
                  zoomMode,
                  annotationVersion,
                  activeTool,
                  selectedAnnotationId
                }}
                class="pdf-page-host pdfViewer bg-white shadow-sm ring-1 ring-border"
              ></div>
              <figcaption class="flex items-center gap-1 text-[10px] text-muted-foreground">
                <FileText class="size-3" aria-hidden="true" />
                Page {pageNumber}
              </figcaption>
            </figure>
          {/each}
        </div>
      </div>

      {#if commentsSidebarOpen}
        <aside
          class="themed-scrollbar flex w-[min(20rem,80vw)] shrink-0 flex-col overflow-auto border-l border-border bg-background"
          aria-label="PDF comments"
        >
          <div class="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
            <div class="text-xs font-medium text-muted-foreground">
              Comments
            </div>
            <div class="text-[10px] text-muted-foreground">
              {commentAnnotations.length}
            </div>
          </div>

          {#if commentAnnotations.length === 0}
            <div class="px-3 py-4 text-xs text-muted-foreground">
              No comments yet.
            </div>
          {:else}
            <div class="flex flex-col gap-2 p-2">
              {#each commentAnnotations as annotation (annotation.id)}
                <section
                  class:ring-1={selectedAnnotationId === annotation.id}
                  class:ring-ring={selectedAnnotationId === annotation.id}
                  class="rounded-md border border-border bg-card p-2 text-card-foreground"
                >
                  <button
                    type="button"
                    class="flex w-full items-center justify-between gap-2 text-left"
                    onclick={() => jumpToAnnotation(annotation.id)}
                  >
                    <span class="text-xs font-medium">
                      Page {annotation.pageIndex + 1}
                    </span>
                    <span
                      class="rounded-sm px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground"
                    >
                      {annotation.type}
                    </span>
                  </button>

                  <textarea
                    class="mt-2 min-h-20 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-ring disabled:cursor-not-allowed disabled:opacity-60"
                    value={annotation.body ?? ''}
                    placeholder="Comment"
                    disabled={isTrashed}
                    oninput={(event) =>
                      updateAnnotation(annotation.id, {
                        body: (event.currentTarget as HTMLTextAreaElement).value
                      })}
                  ></textarea>

                  <div class="mt-2 flex items-center justify-between gap-2">
                    <Button
                      variant={annotation.resolved ? 'secondary' : 'ghost'}
                      size="sm"
                      class="h-7 px-2 text-xs"
                      disabled={isTrashed}
                      onclick={() =>
                        updateAnnotation(annotation.id, {
                          resolved: !annotation.resolved
                        })}
                    >
                      {annotation.resolved ? 'Resolved' : 'Resolve'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="size-7 text-muted-foreground hover:text-destructive"
                      disabled={isTrashed}
                      onclick={() => deleteAnnotation(annotation.id)}
                      aria-label="Delete comment"
                      title="Delete comment"
                    >
                      <Trash2 class="size-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </section>
              {/each}
            </div>
          {/if}
        </aside>
      {/if}
    </div>

    {#if signatureDialogOpen}
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
        role="presentation"
      >
        <div
          class="flex w-[min(34rem,100%)] flex-col rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
          role="dialog"
          aria-modal="true"
          aria-label="Create signature"
        >
          <div class="flex h-9 items-center justify-between border-b border-border px-3">
            <div class="text-xs font-medium text-muted-foreground">
              Signature
            </div>
            <Button
              variant="ghost"
              size="sm"
              class="h-7 px-2 text-xs"
              onclick={closeSignatureDialog}
            >
              Cancel
            </Button>
          </div>

          <div class="p-3">
            <svg
              role="img"
              aria-label="Signature drawing pad"
              class="aspect-[420/168] w-full touch-none rounded-md border border-input bg-white"
              viewBox="0 0 {SIGNATURE_PAD_WIDTH} {SIGNATURE_PAD_HEIGHT}"
              onpointerdown={beginSignaturePadStroke}
              onpointermove={pushSignaturePadPoint}
              onpointerup={finishSignaturePadStroke}
              onpointercancel={finishSignaturePadStroke}
            >
              {#each signaturePadStrokes as stroke (stroke.id)}
                <polyline
                  points={strokePointsAttr(stroke.points)}
                  fill="none"
                  stroke={stroke.color}
                  stroke-width={stroke.width}
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              {/each}
              {#if signaturePadDraft}
                <polyline
                  points={strokePointsAttr(signaturePadDraft.points)}
                  fill="none"
                  stroke={signaturePadDraft.color}
                  stroke-width={signaturePadDraft.width}
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              {/if}
            </svg>
          </div>

          <div class="flex h-10 items-center justify-between border-t border-border px-3">
            <Button
              variant="ghost"
              size="sm"
              class="h-7 px-2 text-xs"
              onclick={clearSignaturePad}
              disabled={signaturePadStrokes.length === 0 && !signaturePadDraft}
            >
              Clear
            </Button>
            <Button
              size="sm"
              class="h-7 px-2 text-xs"
              onclick={saveSignatureFromPad}
              disabled={signaturePadStrokes.length === 0}
            >
              Save
            </Button>
          </div>
        </div>
      </div>
    {/if}

    {#if signaturePickerOpen && signatureMenuRect && savedSignatures.length > 0}
      <div
        bind:this={signaturePickerEl}
        role="menu"
        aria-label={tUi('pdf.signature.menuLabel')}
        class="fixed z-50 rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
        style="left: {signatureMenuLeft}px; top: {signatureMenuTop}px; width: {SIGNATURE_MENU_WIDTH}px;"
      >
        <div class="flex flex-col gap-0.5">
          {#each savedSignatures as signature (signature.id)}
            <div class="flex items-center gap-1 rounded-sm hover:bg-accent">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={activeSignatureId === signature.id}
                class="flex flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left"
                onclick={() => selectSignature(signature.id)}
              >
                <Check
                  class="size-3.5 shrink-0 {activeSignatureId === signature.id
                    ? 'opacity-100'
                    : 'opacity-0'}"
                  aria-hidden="true"
                />
                <svg
                  role="img"
                  aria-label={tUi('pdf.signature.preview')}
                  class="h-8 flex-1 rounded-sm border border-input bg-white"
                  viewBox="0 0 {signature.width} {signature.height}"
                  preserveAspectRatio="xMidYMid meet"
                >
                  {#each signature.strokes as stroke (stroke.id)}
                    <polyline
                      points={strokePointsAttr(stroke.points)}
                      fill="none"
                      stroke={stroke.color}
                      stroke-width={stroke.width}
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  {/each}
                </svg>
              </button>
              <Button
                variant="ghost"
                size="icon"
                class="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                onclick={() => deleteSignature(signature.id)}
                aria-label={tUi('pdf.signature.delete')}
                title={tUi('pdf.signature.delete')}
              >
                <Trash2 class="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          {/each}
        </div>
        <div class="my-1 border-t border-border"></div>
        <button
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
          onclick={openSignaturePad}
        >
          <Plus class="size-3.5 shrink-0" aria-hidden="true" />
          <span>{tUi('pdf.signature.add')}</span>
        </button>
      </div>
    {/if}

    {#if zoomMenuOpen && menuRect}
      <div
        bind:this={zoomMenuEl}
        role="menu"
        class="fixed z-50 min-w-40 rounded-md border border-border bg-popover py-1 text-sm text-popover-foreground shadow-lg"
        style="left: {menuLeft}px; top: {menuTop}px;"
      >
        <button
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
          onclick={setFitWidthZoom}
        >
          <Check
            class="size-4 shrink-0 {zoomMode === 'fit-width' ? 'opacity-100' : 'opacity-0'}"
            aria-hidden="true"
          />
          <span>Fit width</span>
        </button>
        <div class="my-1 border-t border-border"></div>
        {#each QUICK_ZOOMS as option (option)}
          <button
            type="button"
            role="menuitem"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
            onclick={() => setFixedZoom(option)}
          >
            <Check
              class="size-4 shrink-0 {zoomMode === 'fixed' && Math.abs(zoom - option) < 0.01
                ? 'opacity-100'
                : 'opacity-0'}"
              aria-hidden="true"
            />
            <span>{Math.round(option * 100)}%</span>
          </button>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  :global(.pdf-page-host) {
    --scale-factor: 1;
    --page-bg-color: white;
    --page-border: 0;
    --page-margin: 0;
    --pdfViewer-padding-bottom: 0;
    --hcm-highlight-filter: none;
    --hcm-highlight-selected-filter: none;
    background-color: white;
  }

  :global(.pdf-page-host .page) {
    --user-unit: 1;
    --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
    --scale-round-x: 1px;
    --scale-round-y: 1px;
    direction: ltr;
    position: relative;
    overflow: visible;
    margin: 0;
    border: 0;
    background-clip: content-box;
    background-color: var(--page-bg-color);
  }

  :global(.pdf-page-host .canvasWrapper) {
    overflow: hidden;
    width: 100%;
    height: 100%;
  }

  :global(.pdf-page-host .canvasWrapper canvas) {
    position: absolute;
    top: 0;
    left: 0;
    display: block;
    width: 100%;
    height: 100%;
    margin: 0;
    contain: content;
  }

  :global(.pdf-page-host .textLayer) {
    color-scheme: only light;
    position: absolute;
    inset: 0;
    overflow: clip;
    line-height: 1;
    letter-spacing: normal;
    word-spacing: normal;
    text-align: initial;
    transform-origin: 0 0;
    -webkit-text-size-adjust: none;
    -moz-text-size-adjust: none;
    text-size-adjust: none;
    forced-color-adjust: none;
    caret-color: CanvasText;
    --min-font-size: 1;
    --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
    --min-font-size-inv: calc(1 / var(--min-font-size));
  }

  :global(.pdf-page-host .textLayer :is(span, br)) {
    color: transparent;
    position: absolute;
    white-space: pre;
    cursor: text;
    transform-origin: 0% 0%;
    -webkit-user-select: text;
    -moz-user-select: text;
    user-select: text;
  }

  :global(.pdf-page-host .textLayer > :not(.markedContent)),
  :global(.pdf-page-host .textLayer .markedContent span:not(.markedContent)) {
    z-index: 1;
    --font-height: 0;
    font-size: calc(var(--text-scale-factor) * var(--font-height));
    --scale-x: 1;
    --rotate: 0deg;
    transform: rotate(var(--rotate)) scaleX(var(--scale-x))
      scale(var(--min-font-size-inv));
  }

  :global(.pdf-page-host .textLayer .markedContent) {
    display: contents;
  }

  :global(.pdf-page-host .textLayer ::selection),
  :global(.pdf-page-host .textLayer br::selection) {
    background: transparent;
  }

  :global(.pdf-page-host .textLayer .endOfContent) {
    display: block;
    position: absolute;
    inset: 100% 0 0;
    z-index: 0;
    cursor: default;
    -webkit-user-select: none;
    -moz-user-select: none;
    user-select: none;
  }

  :global(.pdf-page-host .textLayer.selecting .endOfContent) {
    top: 0;
  }

  :global(.pdf-page-host .canvasWrapper .selection) {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    background: rgb(0 90 255 / 0.22);
  }

  :global(.pdf-page-host .pdf-app-annotation-layer) {
    position: absolute;
    inset: 0;
    z-index: 3;
    overflow: clip;
    touch-action: none;
  }

  :global(.pdf-page-host .pdf-app-annotation) {
    position: absolute;
    box-sizing: border-box;
    border-radius: 2px;
    cursor: pointer;
    pointer-events: auto;
  }

  :global(.pdf-page-host .pdf-app-annotation-highlight) {
    background: var(--annotation-color);
    opacity: var(--annotation-opacity);
  }

  :global(.pdf-page-host .pdf-app-annotation-comment) {
    border: 2px solid var(--annotation-color);
    background: color-mix(
      in srgb,
      var(--annotation-color) calc(var(--annotation-opacity) * 100%),
      transparent
    );
  }

  :global(.pdf-page-host .pdf-app-annotation-signature) {
    border: 1px solid transparent;
    border-bottom-color: color-mix(
      in srgb,
      var(--annotation-color) 70%,
      transparent
    );
    background: rgb(255 255 255 / 0.54);
    padding: 3px 6px;
  }

  :global(.pdf-page-host .pdf-app-annotation-ink) {
    background: transparent;
  }

  :global(.pdf-page-host .pdf-app-stroke-svg) {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }

  :global(.pdf-page-host .pdf-app-ink-preview) {
    position: absolute;
    inset: 0;
    overflow: visible;
    pointer-events: none;
  }

  :global(.pdf-page-host .pdf-app-annotation-preview) {
    outline: 1px dashed color-mix(in srgb, var(--foreground) 70%, transparent);
    background: rgb(250 204 21 / 0.18);
  }

  :global(.pdf-page-host .pdf-app-annotation-selected) {
    outline: 2px solid color-mix(in srgb, var(--ring) 85%, transparent);
    outline-offset: 2px;
  }

  :global(.pdf-page-host .pdf-app-annotation-resolved) {
    opacity: 0.36;
  }
</style>
