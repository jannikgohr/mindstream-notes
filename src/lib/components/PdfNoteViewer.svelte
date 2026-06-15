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
  import {
    Toolbar,
    ToolbarButton,
    ToolbarSeparator
  } from '$lib/components/ui/toolbar';
  import {
    etebaseSession,
    fetchDrawingAsset,
    getYjsRelayUrl,
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
  import { sanitizePdfFilename } from '$lib/pdf/filename';
  import CommentsSidebar from '$lib/pdf/CommentsSidebar.svelte';
  import SignaturePadDialog from '$lib/pdf/SignaturePadDialog.svelte';
  import SignaturePicker from '$lib/pdf/SignaturePicker.svelte';
  import {
    loadReusableSignatures,
    persistReusableSignatures
  } from '$lib/pdf/signature-storage';
  import {
    cloneSignatureSnapshot,
    strokeBounds,
    strokePointsAttr
  } from '$lib/pdf/stroke-utils';
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
  import {
    registerEditor,
    unregisterEditor,
    type EditorListener
  } from '$lib/hotkeys';

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
    shouldRender: boolean;
    invalidation: number;
  };
  type PageSize = { width: number; height: number };

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
  // Pages within the viewport ± one viewport's worth above/below get a real
  // canvas; everything else stays as a sized placeholder. Picked so smooth
  // scrolling rarely catches a placeholder mid-screen, while a 500-page PDF
  // still holds at most ~5 canvases instead of 500.
  const RENDER_ROOT_MARGIN = '100% 0%';
  // Grace period before a page leaves renderSet — covers the gap between
  // "scrolled past" and "scrolled back to" so scrubbing doesn't churn the
  // pageview lifecycle.
  const RENDER_DROP_DELAY_MS = 200;
  // Settle delay before kicking off a page render. Fast-scroll page
  // transitions enter & leave the band within milliseconds — without this
  // delay, doc.getPage() calls pile up on PDF.js's single worker thread
  // (those calls are NOT cancellable; only the subsequent pageView.draw()
  // is). Visible pages then wait behind the queue. With the delay,
  // transient enters never start a render at all.
  const DRAW_KICKOFF_DELAY_MS = 80;

  let hostEl = $state<HTMLDivElement | null>(null);
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
  let signaturePickerOpen = $state(false);
  let signatureButton = $state<HTMLButtonElement | null>(null);
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
  let editorListener: EditorListener | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let pageIntersectionObserver: IntersectionObserver | null = null;
  let pageRenderObserver: IntersectionObserver | null = null;
  // Per-page visibility ratios — most-visible page wins as the awareness
  // pageIndex. Map (not array) because the observer fires per-page and
  // multiple pages can be partially visible during scroll.
  const pageVisibility = new Map<number, number>();
  // Pre-fetched natural-size viewports (scale=1, PDF units). One entry per
  // page so placeholder figures can be sized correctly without a rendered
  // canvas, keeping scroll position + page-jump targets stable.
  let pageSizes = $state<PageSize[]>([]);
  // Pages currently inside the render window (visible ± buffer). Anything
  // not in this Set renders as a sized blank placeholder — no PDFPageView,
  // no canvas, no text layer. Bookkeeping via the `renderSetVersion`
  // counter because Svelte 5 reactivity doesn't track Set mutations.
  const renderSet = new Set<number>();
  let renderSetVersion = $state(0);
  // Pending teardown timers per page — set when a page leaves the render
  // window, cleared if it re-enters within the grace window.
  const renderDropTimers = new Map<number, ReturnType<typeof setTimeout>>();
  // Per-page cancellation hooks the renderObserver fires the instant a
  // page leaves the band — without this, an in-flight PDF.js render keeps
  // hogging the worker for ~200 ms (the DOM-teardown grace) before the
  // action sees shouldRender=false and tears it down. Cancelling the
  // worker task immediately lets the now-visible page jump the queue.
  const pageCancelHooks = new Map<number, () => void>();
  // Pages whose in-flight render was pre-empted while still inside the
  // grace window. Used to trigger a fresh draw if the user scrolls back
  // before the timer fires (otherwise the canvas would stay partially-
  // drawn until the next zoom/pan invalidation).
  const pageRenderCancelled = new Set<number>();
  // Per-page redraw counter bumped on grace-window re-entry. Threaded
  // through RenderParams so the action sees a `visualChange` and re-runs
  // draw() to complete the cancelled render.
  const pageInvalidation = new Map<number, number>();
  let pageInvalidationVersion = $state(0);
  // Reactive container width drives the fit-width placeholder sizing. The
  // resizeObserver below pushes updates into it.
  let containerWidth = $state(0);
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

  function persistSignatures() {
    persistReusableSignatures(savedSignatures);
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
    signatureDialogOpen = true;
  }

  function handleSignatureSaved(signature: PdfSignatureSnapshot) {
    appendSignature(signature);
    signatureDialogOpen = false;
    activeTool = 'signature';
  }

  function handleSignatureCancelled() {
    signatureDialogOpen = false;
    if (savedSignatures.length === 0) activeTool = 'select';
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
        suggestedName: `${sanitizePdfFilename(title)}.pdf`,
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
        return;
      }
      if (!activeSignatureId) activeSignatureId = savedSignatures[0].id;
      activeTool = 'signature';
      return;
    }
    signaturePickerOpen = false;
    activeTool = activeTool === tool && tool !== 'select' ? 'select' : tool;
  }

  function handlePdfCommand(id: string): boolean {
    switch (id) {
      case 'editor.pdf.select':
        setTool('select');
        return true;
      case 'editor.pdf.highlight':
        if (!isTrashed) setTool('highlight');
        return true;
      case 'editor.pdf.comment':
        if (!isTrashed) setTool('comment');
        return true;
      case 'editor.pdf.pen':
        if (!isTrashed) setTool('pen');
        return true;
      case 'editor.pdf.signature':
        if (!isTrashed) setTool('signature');
        return true;
      case 'editor.pdf.deleteAnnotation':
        if (!isTrashed) setTool('delete');
        return true;
      case 'editor.pdf.toggleComments':
        commentsSidebarOpen = !commentsSidebarOpen;
        return true;
      case 'editor.pdf.export':
        void downloadAnnotatedPdf();
        return true;
      case 'editor.pdf.zoomOut':
        zoomBy(1 / ZOOM_STEP);
        return true;
      case 'editor.pdf.toggleZoomMenu':
        toggleZoomMenu();
        return true;
      case 'editor.pdf.zoomIn':
        zoomBy(ZOOM_STEP);
        return true;
      default:
        console.warn('[PdfNoteViewer] unknown pdf command', id);
        return false;
    }
  }

  const fitWidthZoom = $derived.by(() => {
    if (containerWidth <= 0 || firstPageWidth <= 0) return 1;
    return clampZoom((containerWidth - 32) / firstPageWidth);
  });

  const effectiveZoom = $derived(
    zoomMode === 'fit-width' ? fitWidthZoom : zoom
  );

  // Wraps Set.has so the read is a tracked dependency on `renderSetVersion`.
  // Svelte 5's reactivity ignores Set mutations directly, so the version
  // counter is what actually triggers re-derivation of `shouldRender` per
  // page when the render-window observer changes the set.
  function isRendering(pageNumber: number): boolean {
    void renderSetVersion;
    return renderSet.has(pageNumber);
  }
  function invalidationOf(pageNumber: number): number {
    void pageInvalidationVersion;
    return pageInvalidation.get(pageNumber) ?? 0;
  }
  function invalidatePage(pageNum: number): void {
    pageInvalidation.set(pageNum, (pageInvalidation.get(pageNum) ?? 0) + 1);
    pageInvalidationVersion += 1;
  }

  async function prefetchPageSizes(
    doc: PdfDocument,
    firstPage: Awaited<ReturnType<PdfDocument['getPage']>>
  ) {
    // The first page is already in hand from the load path; reuse it instead
    // of round-tripping again. PDF.js caches page proxies once obtained.
    const first = firstPage.getViewport({ scale: 1 });
    const sizes: PageSize[] = new Array(doc.numPages);
    sizes[0] = { width: first.width, height: first.height };
    // Render the first page's size immediately so the top of the document
    // looks right; the rest stream in as they resolve.
    pageSizes = [...sizes];
    for (let i = 2; i <= doc.numPages; i++) {
      try {
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        sizes[i - 1] = { width: vp.width, height: vp.height };
        // Batched commit every 25 pages keeps Svelte reactivity overhead low
        // on huge documents while still letting the user see progressive
        // placeholder fill-in.
        if (i % 25 === 0 || i === doc.numPages) pageSizes = [...sizes];
      } catch (err) {
        console.warn('[PdfNoteViewer] prefetchPageSizes page', i, err);
      }
    }
  }

  // Placeholder CSS dimensions for a page that isn't yet rendered. Derived
  // from the pre-fetched natural viewport so layout is correct without a
  // canvas — the rendered PDFPageView fills the same box exactly when it
  // later mounts. Falls back to a square approximation while sizes are
  // still loading so the each-block doesn't collapse to zero height.
  function placeholderSize(pageNumber: number): PageSize {
    const size = pageSizes[pageNumber - 1];
    const scale = effectiveZoom;
    if (!size) {
      // Letter-ish fallback so the scroll height is approximately right
      // during the brief window between `pageNumbers` being populated and
      // `pageSizes` finishing its pre-fetch.
      const fallback = firstPageWidth || 612;
      return {
        width: fallback * scale,
        height: fallback * 1.294 * scale
      };
    }
    return { width: size.width * scale, height: size.height * scale };
  }
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

  async function zoomFromWheel(
    deltaY: number,
    clientX: number,
    clientY: number
  ) {
    if (!container) return;
    const previous = effectiveZoom;
    const next = clampZoom(previous * Math.exp(-deltaY * 0.001));
    if (Math.abs(next - previous) < 0.001) return;

    const rect = container.getBoundingClientRect();
    const offsetX = clientX - rect.left;
    const offsetY = clientY - rect.top;
    const xRatio =
      (container.scrollLeft + offsetX) / Math.max(1, container.scrollWidth);
    const yRatio =
      (container.scrollTop + offsetY) / Math.max(1, container.scrollHeight);

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
    const node = container;
    containerWidth = node.clientWidth;
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => {
      menuRectVersion += 1;
      bumpRenderVersion();
      // Drives fit-width placeholder sizing reactively. Without this,
      // placeholder dimensions go stale on window resize even though the
      // canvases redraw fine via the renderVersion bump.
      containerWidth = node.clientWidth;
    });
    resizeObserver.observe(node);
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
    awareness.setLocalStateField(
      'pageIndex',
      Math.max(0, activePageNumber - 1)
    );
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

    // Derived from the single account.serverUrl setting: nginx routes
    // /yjs to the yjs-relay upstream (see backend/nginx/nginx.conf).
    const collabUrl = getYjsRelayUrl(
      (getSettingValue('account.serverUrl') as string | undefined) ?? ''
    );
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
    pageRenderObserver?.disconnect();
    pageVisibility.clear();
    renderSet.clear();
    for (const t of renderDropTimers.values()) clearTimeout(t);
    renderDropTimers.clear();
    pageRenderCancelled.clear();
    // pageCancelHooks is owned by per-action lifecycles, not the effect.
    // pageInvalidation persists across PDF reloads — clearing it would
    // reset all action params' invalidation counter back to 0, which
    // would not trigger redraws on subsequent re-entry events.
    // No renderSetVersion bump here — `renderSetVersion += 1` reads the
    // state, which Svelte 5 records as a dep of this effect; the write
    // then re-triggers the effect, creating a teardown loop. The clear()
    // calls are idempotent on a fresh PDF load (set was already empty)
    // and the cleanup function below handles the bump on a re-run.

    // Visibility observer — drives the active-page indicator + awareness.
    // Tight thresholds, no margin: only truly on-screen pages count.
    const visibilityObserver = new IntersectionObserver(
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
    pageIntersectionObserver = visibilityObserver;

    // Render-window observer — wider rootMargin so a page joins the render
    // set well before it scrolls into view, hiding canvas-draw latency. A
    // page that exits the band is dropped after RENDER_DROP_DELAY_MS to
    // absorb fast scrubs without churning the PDFPageView lifecycle.
    const renderObserver = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const pageAttr = (entry.target as HTMLElement).dataset.pageNumber;
          const pageNum = pageAttr ? Number(pageAttr) : NaN;
          if (!Number.isFinite(pageNum)) continue;
          if (entry.isIntersecting) {
            const existing = renderDropTimers.get(pageNum);
            if (existing) {
              clearTimeout(existing);
              renderDropTimers.delete(pageNum);
            }
            // If a page comes back inside the band before its grace timer
            // fired, its in-flight render had already been pre-empted —
            // bump invalidation so the action restarts draw() instead of
            // leaving the canvas half-finished.
            if (pageRenderCancelled.delete(pageNum)) {
              invalidatePage(pageNum);
            }
            if (!renderSet.has(pageNum)) {
              renderSet.add(pageNum);
              changed = true;
            }
          } else {
            if (!renderSet.has(pageNum)) continue;
            // Pre-empt the in-flight PDF.js render immediately. The DOM
            // teardown is still gated by the grace timer below, so a
            // scrub-back within ~200 ms reuses the existing canvas/figure.
            pageCancelHooks.get(pageNum)?.();
            pageRenderCancelled.add(pageNum);
            if (renderDropTimers.has(pageNum)) continue;
            const timer = setTimeout(() => {
              renderDropTimers.delete(pageNum);
              pageRenderCancelled.delete(pageNum);
              if (renderSet.delete(pageNum)) {
                renderSetVersion += 1;
              }
            }, RENDER_DROP_DELAY_MS);
            renderDropTimers.set(pageNum, timer);
          }
        }
        if (changed) renderSetVersion += 1;
      },
      {
        root: container,
        rootMargin: RENDER_ROOT_MARGIN,
        threshold: 0
      }
    );
    pageRenderObserver = renderObserver;

    // Observe after DOM updates so all page wrappers exist.
    void tick().then(() => {
      const targets =
        container?.querySelectorAll<HTMLElement>('[data-page-number]');
      targets?.forEach((el) => {
        visibilityObserver.observe(el);
        renderObserver.observe(el);
      });
    });
    return () => {
      visibilityObserver.disconnect();
      renderObserver.disconnect();
      pageIntersectionObserver = null;
      pageRenderObserver = null;
      pageVisibility.clear();
      renderSet.clear();
      for (const t of renderDropTimers.values()) clearTimeout(t);
      renderDropTimers.clear();
      pageRenderCancelled.clear();
    };
  });

  onMount(async () => {
    savedSignatures = loadReusableSignatures();
    activeSignatureId = savedSignatures[0]?.id ?? null;
    await tick();
    if (hostEl) {
      editorListener = {
        kind: 'pdf',
        host: hostEl,
        onCommand: handlePdfCommand
      };
      registerEditor(editorListener);
    }
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
      // Pre-fetch every page's natural viewport so the each-block can size
      // placeholders correctly before (and instead of) a canvas mounts.
      // PDF.js caches page proxies, so this is cheap and one-shot.
      void prefetchPageSizes(pdfDoc, firstPage);
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

  onDestroy(() => {
    if (saveTimer) {
      void flushSave();
    }
    saveReady = false;
    if (editorListener) {
      unregisterEditor(editorListener);
      editorListener = null;
    }
    unsubSync?.();
    unsubSync = null;
    unsubSession?.();
    unsubSession = null;
    resizeObserver?.disconnect();
    pageIntersectionObserver?.disconnect();
    pageIntersectionObserver = null;
    pageRenderObserver?.disconnect();
    pageRenderObserver = null;
    pageVisibility.clear();
    renderSet.clear();
    for (const t of renderDropTimers.values()) clearTimeout(t);
    renderDropTimers.clear();
    pageRenderCancelled.clear();
    pageCancelHooks.clear();
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
    let currentViewport: ReturnType<
      Awaited<ReturnType<PdfDocument['getPage']>>['getViewport']
    > | null = null;
    // Register the in-flight-cancel hook so the renderObserver can pre-empt
    // this page's render the instant the page leaves the band — even if
    // the DOM teardown is still inside its 200 ms grace window. Three
    // things happen here, in order:
    //   1. cancelScheduledDraw — if the kickoff timer hasn't fired yet,
    //      kill it. This is what stops doc.getPage() pileups on PDF.js's
    //      single worker thread during fast scroll: a page that's in the
    //      band for less than DRAW_KICKOFF_DELAY_MS never queues a fetch.
    //   2. drawGeneration += 1 — any in-flight draw() awaiting at the
    //      checkpoints below will read the new generation and bail.
    //   3. pageView.cancelRendering — interrupts the pageView's own
    //      render task (only relevant once draw() got past getPage()).
    pageCancelHooks.set(current.pageNumber, () => {
      cancelScheduledDraw();
      drawGeneration += 1;
      pageView?.cancelRendering();
    });

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
          node.style.setProperty(
            '--annotation-opacity',
            `${annotation.opacity}`
          );
          if (annotation.body) node.title = annotation.body;
          if (annotation.type === 'signature' && annotation.signature) {
            const svg = document.createElementNS(
              'http://www.w3.org/2000/svg',
              'svg'
            );
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
            const svg = document.createElementNS(
              'http://www.w3.org/2000/svg',
              'svg'
            );
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
              polyline.setAttribute(
                'stroke-width',
                `${stroke.width * viewport.scale}`
              );
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
          preview.setAttribute(
            'viewBox',
            `0 0 ${pageRect.width} ${pageRect.height}`
          );
          preview.classList.add('pdf-app-ink-preview');
          const previewStroke = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'polyline'
          );
          previewStroke.setAttribute('fill', 'none');
          previewStroke.setAttribute('stroke', INK_COLOR);
          previewStroke.setAttribute(
            'stroke-width',
            `${INK_WIDTH * viewport.scale}`
          );
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
            previewStroke.setAttribute(
              'points',
              strokePointsAttr(viewportPoints)
            );
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
            createAnnotation('ink', current.pageNumber - 1, rect, undefined, {
              strokes: [
                {
                  id: crypto.randomUUID(),
                  points: pdfPoints,
                  color: INK_COLOR,
                  width: INK_WIDTH
                }
              ]
            });
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
        if (
          current.activeTool === 'signature' &&
          savedSignatures.length === 0
        ) {
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

    function teardownPageView() {
      pageView?.cancelRendering();
      pageView?.destroy();
      pageView = null;
      currentViewport = null;
      pageSurface.replaceChildren();
    }

    let drawKickoffTimer: ReturnType<typeof setTimeout> | null = null;
    function cancelScheduledDraw() {
      if (drawKickoffTimer) {
        clearTimeout(drawKickoffTimer);
        drawKickoffTimer = null;
      }
    }
    function scheduleDraw() {
      cancelScheduledDraw();
      drawKickoffTimer = setTimeout(() => {
        drawKickoffTimer = null;
        void draw();
      }, DRAW_KICKOFF_DELAY_MS);
    }

    async function draw() {
      const generation = ++drawGeneration;
      const request = { ...current };
      const doc = pdfDoc;
      const pdfjs = pdfjsLib;
      const pdfViewer = pdfViewerLib;
      const renderContainer = container;
      if (!doc || !pdfjs || !pdfViewer || !renderContainer) return;
      if (!request.shouldRender) {
        teardownPageView();
        return;
      }
      teardownPageView();

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
        if (
          (err as { name?: string })?.name !== 'RenderingCancelledException'
        ) {
          console.warn('[PdfNoteViewer] page render failed', err);
        }
      }
    }

    // Initial mount: respect shouldRender like any other transition.
    // shouldRender=false short-circuits inside draw() so no worker calls
    // happen for the 95+ off-screen pages mounted at PDF open.
    if (params.shouldRender) scheduleDraw();
    return {
      update(next: RenderParams) {
        const prev = current;
        current = next;
        // Page entered the render window — draw it. Page left the window
        // (or pageNumber/zoom changed) — let draw() decide whether to
        // teardown or redraw, based on the now-current shouldRender flag.
        const enteringRender = next.shouldRender && !prev.shouldRender;
        const leavingRender = !next.shouldRender && prev.shouldRender;
        const visualChange =
          next.pageNumber !== prev.pageNumber ||
          next.version !== prev.version ||
          next.zoom !== prev.zoom ||
          next.zoomMode !== prev.zoomMode ||
          // Bumped when an externally-cancelled render needs to restart
          // after the user scrolled back inside the band before grace.
          next.invalidation !== prev.invalidation;
        if (leavingRender) {
          // Tear down immediately — the now-irrelevant pageView is hogging
          // worker capacity that a visible page needs. No debounce here.
          cancelScheduledDraw();
          void draw();
        } else if (enteringRender || visualChange) {
          // Debounce. Fast scrolling fires enteringRender for many pages
          // in quick succession; each call to scheduleDraw clears the
          // previous timer, so a page that's been in the band for less
          // than DRAW_KICKOFF_DELAY_MS never calls doc.getPage(). That
          // keeps the worker queue uncontended for whichever page the
          // user actually settles on.
          scheduleDraw();
        } else if (next.shouldRender) {
          // Same page, same zoom, still rendered — only annotation state
          // changed. Skip the canvas redraw and just refresh overlays.
          renderAppAnnotations();
        }
      },
      destroy() {
        cancelled = true;
        drawGeneration += 1;
        cancelScheduledDraw();
        pageCancelHooks.delete(current.pageNumber);
        teardownPageView();
      }
    };
  }
</script>

<div bind:this={hostEl} class="flex h-full w-full flex-col bg-background">
  {#if loading}
    <div
      class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
    >
      <Loader2 class="size-4 animate-spin" aria-hidden="true" />
      <span>Loading PDF…</span>
    </div>
  {:else if error}
    <div
      class="flex h-full items-center justify-center gap-2 p-6 text-sm text-destructive"
    >
      <AlertCircle class="size-4 shrink-0" aria-hidden="true" />
      <span>{error}</span>
    </div>
  {:else}
    <Toolbar
      dense
      aria-label="PDF controls"
      class="shrink-0 justify-between border-b border-border bg-background"
    >
      <div class="flex items-center gap-0.5">
        <ToolbarButton
          active={activeTool === 'select'}
          onclick={() => setTool('select')}
          aria-label="Select"
          title="Select"
          aria-pressed={activeTool === 'select'}
        >
          <MousePointer2 aria-hidden="true" />
        </ToolbarButton>

        <ToolbarButton
          active={activeTool === 'highlight'}
          onclick={() => setTool('highlight')}
          aria-label="Highlight"
          title="Highlight"
          aria-pressed={activeTool === 'highlight'}
          disabled={isTrashed}
        >
          <Highlighter aria-hidden="true" />
        </ToolbarButton>

        <ToolbarButton
          active={activeTool === 'comment'}
          onclick={() => setTool('comment')}
          aria-label="Comment"
          title="Comment"
          aria-pressed={activeTool === 'comment'}
          disabled={isTrashed}
        >
          <MessageSquarePlus aria-hidden="true" />
        </ToolbarButton>

        <ToolbarButton
          active={activeTool === 'pen'}
          onclick={() => setTool('pen')}
          aria-label="Pen"
          title="Pen"
          aria-pressed={activeTool === 'pen'}
          disabled={isTrashed}
        >
          <PenLine aria-hidden="true" />
        </ToolbarButton>

        <ToolbarButton
          bind:ref={signatureButton}
          active={activeTool === 'signature'}
          onclick={() => setTool('signature')}
          aria-label="Sign"
          title="Sign"
          aria-pressed={activeTool === 'signature'}
          aria-haspopup="menu"
          aria-expanded={signaturePickerOpen}
          disabled={isTrashed}
        >
          <Signature aria-hidden="true" />
        </ToolbarButton>

        <ToolbarButton
          active={activeTool === 'delete'}
          onclick={() => setTool('delete')}
          aria-label="Delete annotation"
          title="Delete annotation"
          aria-pressed={activeTool === 'delete'}
          disabled={isTrashed}
        >
          <Trash2 aria-hidden="true" />
        </ToolbarButton>

        <ToolbarSeparator />

        <ToolbarButton
          active={commentsSidebarOpen}
          onclick={() => (commentsSidebarOpen = !commentsSidebarOpen)}
          aria-label="Toggle comments"
          title="Toggle comments"
          aria-pressed={commentsSidebarOpen}
        >
          <MessagesSquare aria-hidden="true" />
        </ToolbarButton>

        <ToolbarButton
          onclick={() => void downloadAnnotatedPdf()}
          aria-label={tUi('pdf.export.label')}
          title={exportError
            ? `${tUi('pdf.export.failed')}: ${exportError}`
            : tUi('pdf.export.label')}
          disabled={exportInProgress || !pdfDoc}
        >
          {#if exportInProgress}
            <Loader2 class="animate-spin" aria-hidden="true" />
          {:else}
            <Download aria-hidden="true" />
          {/if}
        </ToolbarButton>
      </div>

      <div class="flex items-center gap-0.5">
        <ToolbarButton
          onclick={() => zoomBy(1 / ZOOM_STEP)}
          aria-label="Zoom out"
          title="Zoom out"
        >
          <Minus aria-hidden="true" />
        </ToolbarButton>

        <ToolbarButton
          bind:ref={zoomButton}
          wide
          class="min-w-22 justify-center font-medium text-muted-foreground"
          onclick={toggleZoomMenu}
          aria-haspopup="menu"
          aria-expanded={zoomMenuOpen}
          title="Choose zoom"
        >
          <span>{zoomLabel}</span>
          <ChevronDown aria-hidden="true" />
        </ToolbarButton>

        <ToolbarButton
          onclick={() => zoomBy(ZOOM_STEP)}
          aria-label="Zoom in"
          title="Zoom in"
        >
          <Plus aria-hidden="true" />
        </ToolbarButton>
      </div>
    </Toolbar>

    <div class="flex min-h-0 flex-1 overflow-hidden">
      <div
        bind:this={container}
        use:ctrlWheelZoom
        class="themed-scrollbar min-h-0 flex-1 overflow-auto px-3 py-4"
      >
        <div class="mx-auto flex min-w-full w-max flex-col items-center gap-4">
          {#each pageNumbers as pageNumber (pageNumber)}
            {@const size = placeholderSize(pageNumber)}
            {@const shouldRender = isRendering(pageNumber)}
            {@const invalidation = invalidationOf(pageNumber)}
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
                  selectedAnnotationId,
                  shouldRender,
                  invalidation
                }}
                style="width:{size.width}px; height:{size.height}px"
                class="pdf-page-host pdfViewer bg-white shadow-sm ring-1 ring-border"
              ></div>
              <figcaption
                class="flex items-center gap-1 text-[10px] text-muted-foreground"
              >
                <FileText class="size-3" aria-hidden="true" />
                Page {pageNumber}
              </figcaption>
            </figure>
          {/each}
        </div>
      </div>

      {#if commentsSidebarOpen}
        <CommentsSidebar
          annotations={commentAnnotations}
          {selectedAnnotationId}
          {isTrashed}
          onJump={jumpToAnnotation}
          onUpdate={updateAnnotation}
          onDelete={deleteAnnotation}
        />
      {/if}
    </div>

    <SignaturePadDialog
      open={signatureDialogOpen}
      onCancel={handleSignatureCancelled}
      onSave={handleSignatureSaved}
    />

    <SignaturePicker
      open={signaturePickerOpen}
      anchor={signatureButton}
      signatures={savedSignatures}
      {activeSignatureId}
      onSelect={selectSignature}
      onDelete={deleteSignature}
      onAddNew={openSignaturePad}
      onClose={() => (signaturePickerOpen = false)}
    />

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
            class="size-4 shrink-0 {zoomMode === 'fit-width'
              ? 'opacity-100'
              : 'opacity-0'}"
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
              class="size-4 shrink-0 {zoomMode === 'fixed' &&
              Math.abs(zoom - option) < 0.01
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
