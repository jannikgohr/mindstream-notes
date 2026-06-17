<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
  import {
    AlertCircle,
    ChevronLeft,
    ChevronRight,
    FileText,
    Highlighter,
    Loader2,
    MessageSquarePlus,
    MessagesSquare,
    PanelLeft,
    PenLine,
    Redo2,
    Signature,
    SquareDashed,
    TextCursor,
    Trash2,
    Undo2
  } from 'lucide-svelte';
  import * as Y from 'yjs';
  import { Awareness } from 'y-protocols/awareness';
  import {
    Toolbar,
    ToolbarButton,
    ToolbarSeparator,
    ToolbarZoomControls
  } from '$lib/components/ui/toolbar';
  import {
    etebaseSession,
    fetchDrawingAsset,
    getYjsRelayUrl,
    isTauri,
    loadNote,
    noteRoomInfo,
    onSessionChange,
    saveNote as apiSaveNote
  } from '$lib/api';
  import { listen } from '$lib/api/events';
  import { base64ToBytes } from '$lib/editor/base64';
  import { pickCursorColor } from '$lib/editor/cursor-color';
  import { isMobile } from '$lib/platform';
  import { getSettingValue } from '$lib/settings/store.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { exportAnnotatedPdfNote } from '$lib/note-exporters/pdf';
  import FindBar from '$lib/components/FindBar.svelte';
  import CommentsSidebar from '$lib/pdf/CommentsSidebar.svelte';
  import PdfNavigatorSidebar from '$lib/pdf/PdfNavigatorSidebar.svelte';
  import PdfAnnotationMenu from '$lib/pdf/PdfAnnotationMenu.svelte';
  import PdfSelectionMenu from '$lib/pdf/PdfSelectionMenu.svelte';
  import SignaturePadDialog from '$lib/pdf/SignaturePadDialog.svelte';
  import SignaturePicker from '$lib/pdf/SignaturePicker.svelte';
  import {
    loadFlatOutline,
    resolveDestinationPageIndex,
    type FlatOutlineItem
  } from '$lib/pdf/outline';
  import {
    buildPageTextIndex,
    findMatchesInPage,
    type PageTextIndex,
    type PdfSearchMatch
  } from '$lib/pdf/pdf-text-index';
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
    SEARCH_ACTIVE_NOTE_COMMAND,
    type EditorListener
  } from '$lib/hotkeys';
  import { alert } from './confirm-dialog.svelte';

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
    areaMode: boolean;
    selectedAnnotationId: string | null;
    shouldRender: boolean;
    invalidation: number;
    searchVersion: number;
  };
  type PageSize = { width: number; height: number };
  type PdfViewport = ReturnType<
    Awaited<ReturnType<PdfDocument['getPage']>>['getViewport']
  >;
  type PdfLink = {
    rect: number[];
    url?: string;
    dest?: string | unknown[] | null;
  };

  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 4;
  const ZOOM_STEP = 1.2;
  const QUICK_ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  const PDF_TO_CSS_UNITS = 96 / 72;
  const SAVE_DEBOUNCE_MS = 800;
  const SEARCH_DEBOUNCE_MS = 220;
  const HIGHLIGHT_COLOR = '#facc15';
  const COMMENT_COLOR = '#3b82f6';
  const SIGNATURE_COLOR = '#111827';
  const INK_COLOR = '#111827';
  const INK_WIDTH = 2.25;
  // Swatches offered for the highlight and pen tools.
  const ANNOTATION_COLORS = [
    '#facc15',
    '#fb923c',
    '#f87171',
    '#4ade80',
    '#60a5fa',
    '#c084fc',
    '#111827'
  ];
  // Transaction origin tagging local annotation edits, so the Yjs
  // UndoManager captures only our own changes and never undoes a peer's
  // edit or a sync merge (both applied with a different origin).
  const LOCAL_ORIGIN = Symbol('pdf-local-change');
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
  let mobileToolbar = $state(false);
  let annotationVersion = $state(0);
  let annotations = $state<PdfAnnotation[]>([]);
  let activeTool = $state<PdfTool>('select');
  // When on, the highlight/comment tools draw a freeform rectangle (for
  // figures / scanned pages with no text); when off they're text-aware
  // and act on the text selection.
  let areaMode = $state(false);
  let commentsSidebarOpen = $state(false);
  let selectedAnnotationId = $state<string | null>(null);
  // Etebase username stamped on annotations this user creates; the
  // sidebar shows it as the author (and "You" when it's the local user).
  let localAuthorId = $state('local');
  // Id of a just-created comment whose editor should grab focus once the
  // sidebar renders it (replaces the old window.prompt flow).
  let commentDraftFocusId = $state<string | null>(null);
  // Per-tool colour for new annotations.
  let highlightColor = $state(HIGHLIGHT_COLOR);
  let inkColor = $state(INK_COLOR);
  let undoManager: Y.UndoManager | null = null;
  let canUndo = $state(false);
  let canRedo = $state(false);
  // Floating bubble for text-aware highlight/comment on a text selection.
  let selectionMenu = $state<{ x: number; y: number } | null>(null);
  // Action popup for the currently-selected annotation (add comment /
  // colour / delete), positioned above it in client coords.
  let annotationMenu = $state<{ x: number; y: number } | null>(null);
  // Latest rendered viewport per page, so selection client-rects can be
  // converted back into PDF user space. Updated in the render action.
  const pageViewports = new Map<number, PdfViewport>();
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
  let pageInputValue = $state('1');
  let pageInputFocused = false;
  let navigatorOpen = $state(false);
  let outline = $state<FlatOutlineItem[]>([]);
  let searchOpen = $state(false);
  let searchQuery = $state('');
  let searchBusy = $state(false);
  let searchMatches = $state<PdfSearchMatch[]>([]);
  let activeMatchIndex = $state(0);
  // Bumped to re-run the per-page overlay pass when search results change.
  let searchVersion = $state(0);
  let searchBar = $state<{ focus: () => void } | null>(null);
  // Plain (non-reactive) lookups read imperatively inside the render
  // action. `searchMatchesByPage` indexes matches by 0-based page;
  // `activeSearchMatchId` flags the currently-focused hit.
  const searchMatchesByPage = new Map<number, PdfSearchMatch[]>();
  let activeSearchMatchId: string | null = null;
  // Per-page text index, built lazily on first search and cached.
  const textIndexCache = new Map<number, PageTextIndex>();
  let searchGeneration = 0;
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
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

  // Run a local annotation mutation inside a tagged transaction so the
  // UndoManager records it (and only it). Falls back to a bare call
  // before the Y.Doc exists.
  function runLocal(fn: () => void) {
    if (yDoc) yDoc.transact(fn, LOCAL_ORIGIN);
    else fn();
  }

  function createAnnotation(
    type: PdfAnnotationType,
    pageIndex: number,
    rect: PdfRect | PdfRect[],
    body?: string,
    extras: Partial<Pick<PdfAnnotation, 'strokes' | 'signature'>> = {}
  ): string | null {
    const map = annotationsMap;
    if (!map || isTrashed) return null;
    const rects = Array.isArray(rect) ? rect : [rect];
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    runLocal(() => {
      map.set(id, {
        id,
        type,
        pageIndex,
        rects,
        color:
          type === 'highlight'
            ? highlightColor
            : type === 'comment'
              ? COMMENT_COLOR
              : type === 'ink'
                ? inkColor
                : SIGNATURE_COLOR,
        opacity: type === 'highlight' ? 0.32 : type === 'comment' ? 0.18 : 1,
        authorId: localAuthorId,
        createdAt: now,
        updatedAt: now,
        body,
        ...extras
      });
    });
    selectedAnnotationId = id;
    if (type === 'comment') {
      commentsSidebarOpen = true;
      commentDraftFocusId = id;
    }
    return id;
  }

  function isCommentLikeAnnotation(annotation: PdfAnnotation): boolean {
    // A highlight is "comment-like" once it carries a body string — even
    // an empty one, which is the pending state of a just-created text
    // comment (select text → Comment). `undefined` body = a plain
    // highlight, which stays out of the comments sidebar.
    return (
      annotation.type === 'comment' ||
      (annotation.type === 'highlight' && typeof annotation.body === 'string')
    );
  }

  function deleteAnnotation(id: string) {
    if (isTrashed) return;
    runLocal(() => annotationsMap?.delete(id));
    if (selectedAnnotationId === id) selectedAnnotationId = null;
  }

  function updateAnnotation(id: string, patch: Partial<PdfAnnotation>) {
    const map = annotationsMap;
    if (isTrashed || !map) return;
    const existing = map.get(id);
    if (!existing) return;
    runLocal(() => {
      map.set(id, {
        ...existing,
        ...patch,
        updatedAt: new Date().toISOString()
      });
    });
  }

  function undo() {
    undoManager?.undo();
  }

  function redo() {
    undoManager?.redo();
  }

  // The colour the active drawing tool paints with; the swatch row binds
  // to this and writes back through setActiveColor.
  const activeColor = $derived(
    activeTool === 'pen' ? inkColor : highlightColor
  );

  function setActiveColor(color: string) {
    if (activeTool === 'pen') inkColor = color;
    else highlightColor = color;
  }

  // --- Text selection → text-aware highlight / comment ----------------------

  type PdfSelection = {
    range: Range;
    pageEl: HTMLElement;
    pageNumber: number;
    viewport: PdfViewport;
  };

  /** Resolve the current DOM selection to the PDF page it sits in, or
   *  null when there's no usable text selection inside a rendered page. */
  function readPdfSelection(): PdfSelection | null {
    if (!container) return null;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el =
      node.nodeType === Node.TEXT_NODE
        ? node.parentElement
        : (node as Element | null);
    if (!el || !container.contains(el)) return null;
    // Scope to our wrapper <figure>: pdf.js also stamps data-page-number
    // on its inner `.page` div, so a bare [data-page-number] would match
    // that instead and the `.page` lookup below would then fail.
    const figure = el.closest<HTMLElement>('figure[data-page-number]');
    const pageEl = figure?.querySelector<HTMLElement>('.page') ?? null;
    if (!figure || !pageEl) return null;
    const pageNumber = Number(figure.dataset.pageNumber);
    const viewport = pageViewports.get(pageNumber);
    if (!Number.isFinite(pageNumber) || !viewport) return null;
    return { range, pageEl, pageNumber, viewport };
  }

  /** Convert the selection's per-line client rects into PDF user-space
   *  rects, clipped to the owning page so a spill onto the next page
   *  doesn't produce mis-placed quads. */
  function selectionRectsToPdf(selection: PdfSelection): PdfRect[] {
    const { range, pageEl, viewport } = selection;
    const pageRect = pageEl.getBoundingClientRect();
    const rects: PdfRect[] = [];
    for (const cr of Array.from(range.getClientRects())) {
      if (cr.width < 1 || cr.height < 1) continue;
      if (cr.bottom <= pageRect.top || cr.top >= pageRect.bottom) continue;
      const [x1, y1] = viewport.convertToPdfPoint(
        cr.left - pageRect.left,
        cr.top - pageRect.top
      );
      const [x2, y2] = viewport.convertToPdfPoint(
        cr.right - pageRect.left,
        cr.bottom - pageRect.top
      );
      rects.push({
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1)
      });
    }
    return rects;
  }

  function refreshSelectionMenu() {
    if (activeTool !== 'select' || isTrashed) {
      selectionMenu = null;
      return;
    }
    const selection = readPdfSelection();
    if (!selection) {
      selectionMenu = null;
      return;
    }
    const rect = selection.range.getBoundingClientRect();
    if (rect.width < 1 && rect.height < 1) {
      selectionMenu = null;
      return;
    }
    const centerX = Math.min(
      window.innerWidth - 60,
      Math.max(60, rect.left + rect.width / 2)
    );
    selectionMenu = { x: centerX, y: rect.top };
  }

  function clearSelectionMenu() {
    selectionMenu = null;
  }

  function endSelectionAction() {
    window.getSelection()?.removeAllRanges();
    selectionMenu = null;
  }

  function highlightSelection() {
    const selection = readPdfSelection();
    if (!selection || isTrashed) {
      endSelectionAction();
      return;
    }
    const rects = selectionRectsToPdf(selection);
    if (rects.length > 0) {
      createAnnotation('highlight', selection.pageNumber - 1, rects);
    }
    endSelectionAction();
  }

  function commentSelection() {
    const selection = readPdfSelection();
    if (!selection || isTrashed) {
      endSelectionAction();
      return;
    }
    const rects = selectionRectsToPdf(selection);
    if (rects.length > 0) {
      // A highlight carrying a body reads as a comment everywhere (sidebar,
      // export), so a text comment is a highlight anchored to the selection
      // with an empty, focus-ready body.
      const id = createAnnotation(
        'highlight',
        selection.pageNumber - 1,
        rects,
        ''
      );
      if (id) {
        commentsSidebarOpen = true;
        commentDraftFocusId = id;
      }
    }
    endSelectionAction();
  }

  // Whether the active highlight/comment tool acts on the text selection
  // (Acrobat-style text-aware tool) rather than drawing an area box.
  const textToolActive = $derived(
    !areaMode && (activeTool === 'highlight' || activeTool === 'comment')
  );

  // Track the live selection. In select mode we surface the bubble above
  // it; with a text-aware tool active we instead apply that tool's
  // annotation directly when the drag/keyboard selection ends.
  // selectionchange covers mouse, touch and keyboard; scroll/resize hide
  // the bubble since its fixed position would otherwise go stale.
  $effect(() => {
    if (!container) return;
    const scrollEl = container;
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(refreshSelectionMenu);
    };
    const onPointerUp = () => {
      if (textToolActive && !isTrashed) {
        // Defer a frame so the selection has finalised, then apply.
        requestAnimationFrame(() => {
          if (activeTool === 'highlight') highlightSelection();
          else if (activeTool === 'comment') commentSelection();
        });
        return;
      }
      schedule();
    };
    document.addEventListener('selectionchange', schedule);
    scrollEl.addEventListener('pointerup', onPointerUp);
    scrollEl.addEventListener('scroll', clearSelectionMenu, { passive: true });
    window.addEventListener('resize', clearSelectionMenu);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('selectionchange', schedule);
      scrollEl.removeEventListener('pointerup', onPointerUp);
      scrollEl.removeEventListener('scroll', clearSelectionMenu);
      window.removeEventListener('resize', clearSelectionMenu);
    };
  });

  // --- Selected-annotation action popup -------------------------------------

  const selectedAnnotation = $derived(
    selectedAnnotationId
      ? (annotations.find((a) => a.id === selectedAnnotationId) ?? null)
      : null
  );

  /** Position the action popup above the selected annotation, in client
   *  coords, or hide it when the annotation is unrendered / scrolled out
   *  of the viewport. */
  function updateAnnotationMenu() {
    const ann = selectedAnnotation;
    if (!ann || isTrashed || !container) {
      annotationMenu = null;
      return;
    }
    const pageNum = ann.pageIndex + 1;
    const figure = container.querySelector<HTMLElement>(
      `figure[data-page-number="${pageNum}"]`
    );
    const pageEl = figure?.querySelector<HTMLElement>('.page') ?? null;
    const viewport = pageViewports.get(pageNum);
    if (!pageEl || !viewport) {
      annotationMenu = null;
      return;
    }
    const pageRect = pageEl.getBoundingClientRect();
    let minTop = Infinity;
    let maxBottom = -Infinity;
    let minLeft = Infinity;
    let maxRight = -Infinity;
    for (const rect of ann.rects) {
      const [x1, y1] = viewport.convertToViewportPoint(rect.x, rect.y);
      const [x2, y2] = viewport.convertToViewportPoint(
        rect.x + rect.width,
        rect.y + rect.height
      );
      minTop = Math.min(minTop, y1, y2);
      maxBottom = Math.max(maxBottom, y1, y2);
      minLeft = Math.min(minLeft, x1, x2);
      maxRight = Math.max(maxRight, x1, x2);
    }
    if (!Number.isFinite(minTop)) {
      annotationMenu = null;
      return;
    }
    const cont = container.getBoundingClientRect();
    const topClient = pageRect.top + minTop;
    const bottomClient = pageRect.top + maxBottom;
    // Hide when the annotation is fully outside the scroll viewport.
    if (bottomClient < cont.top || topClient > cont.bottom) {
      annotationMenu = null;
      return;
    }
    // Clamp so the bubble (drawn above `y`) stays inside the viewport.
    const y = Math.max(topClient, cont.top + 52);
    const centerClient = pageRect.left + (minLeft + maxRight) / 2;
    const x = Math.min(window.innerWidth - 90, Math.max(90, centerClient));
    annotationMenu = { x, y };
  }

  // Recompute when the selection, geometry (zoom), or annotation set
  // changes — deferred a frame so the page layout has settled first.
  $effect(() => {
    void selectedAnnotationId;
    void annotationVersion;
    void renderVersion;
    void zoom;
    void zoomMode;
    void containerWidth;
    const id = requestAnimationFrame(updateAnnotationMenu);
    return () => cancelAnimationFrame(id);
  });

  // Follow the annotation as the page scrolls (the popup is viewport-fixed).
  $effect(() => {
    if (!container) return;
    const scrollEl = container;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(updateAnnotationMenu);
    };
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      scrollEl.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  });

  function addCommentToSelected() {
    const ann = selectedAnnotation;
    if (!ann || isTrashed) return;
    // Give the highlight an (empty) body so it reads as a comment, then
    // open the sidebar focused on it.
    updateAnnotation(ann.id, { body: ann.body ?? '' });
    commentsSidebarOpen = true;
    commentDraftFocusId = ann.id;
  }

  function recolorSelected(color: string) {
    const ann = selectedAnnotation;
    if (!ann || isTrashed) return;
    updateAnnotation(ann.id, { color });
  }

  function deleteSelectedAnnotation() {
    if (selectedAnnotationId) deleteAnnotation(selectedAnnotationId);
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

  // --- Page navigation ------------------------------------------------------

  function scrollToPage(
    pageNumber: number,
    behavior: ScrollBehavior = 'smooth'
  ) {
    const total = pageNumbers.length;
    if (total === 0) return;
    const clamped = Math.min(total, Math.max(1, pageNumber));
    const target = container?.querySelector<HTMLElement>(
      `[data-page-number="${clamped}"]`
    );
    target?.scrollIntoView({ block: 'start', behavior });
    activePageNumber = clamped;
  }

  function goToPreviousPage() {
    scrollToPage(activePageNumber - 1);
  }

  function goToNextPage() {
    scrollToPage(activePageNumber + 1);
  }

  function commitPageInput() {
    const parsed = Number.parseInt(pageInputValue, 10);
    if (Number.isFinite(parsed)) {
      scrollToPage(parsed);
    }
    pageInputValue = String(activePageNumber);
  }

  // Keep the page-number field in sync with the scroll position, but never
  // clobber what the user is actively typing.
  $effect(() => {
    if (!pageInputFocused) pageInputValue = String(activePageNumber);
  });

  function toggleNavigator() {
    navigatorOpen = !navigatorOpen;
  }

  // --- PDF links ------------------------------------------------------------

  async function openExternalUrl(url: string) {
    // Restrict to navigational schemes — never follow file: or javascript:
    // URLs embedded in a document.
    if (!/^(https?:|mailto:)/i.test(url)) return;
    try {
      if (isTauri()) {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(url);
      } else if (typeof window !== 'undefined') {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      console.warn('[PdfNoteViewer] failed to open link', url, err);
    }
  }

  async function followLinkDest(dest: string | unknown[] | null | undefined) {
    if (!pdfDoc || dest == null) return;
    const pageIndex = await resolveDestinationPageIndex(pdfDoc, dest);
    if (pageIndex != null) scrollToPage(pageIndex + 1);
  }

  // --- In-document search ---------------------------------------------------

  function openSearch() {
    searchOpen = true;
    void tick().then(() => searchBar?.focus());
  }

  function closeSearch() {
    searchOpen = false;
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    searchGeneration += 1;
    searchQuery = '';
    clearSearchResults();
  }

  function clearSearchResults() {
    searchMatches = [];
    searchMatchesByPage.clear();
    activeMatchIndex = 0;
    activeSearchMatchId = null;
    searchBusy = false;
    searchVersion += 1;
  }

  function handleSearchInput(value: string) {
    searchQuery = value;
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = null;
      void runSearch(value);
    }, SEARCH_DEBOUNCE_MS);
  }

  function indexMatchesByPage(matches: PdfSearchMatch[]) {
    searchMatchesByPage.clear();
    for (const match of matches) {
      const list = searchMatchesByPage.get(match.pageIndex);
      if (list) list.push(match);
      else searchMatchesByPage.set(match.pageIndex, [match]);
    }
  }

  async function runSearch(rawQuery: string) {
    const query = rawQuery.trim();
    const generation = ++searchGeneration;
    if (!query || !pdfDoc) {
      clearSearchResults();
      return;
    }
    searchBusy = true;
    const doc = pdfDoc;
    const collected: PdfSearchMatch[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      let index = textIndexCache.get(pageNumber - 1);
      if (!index) {
        try {
          const page = await doc.getPage(pageNumber);
          index = await buildPageTextIndex(page);
        } catch (err) {
          console.warn('[PdfNoteViewer] text index failed', pageNumber, err);
          index = { text: '', segments: [] };
        }
        textIndexCache.set(pageNumber - 1, index);
      }
      // A newer query superseded this run — abandon it.
      if (generation !== searchGeneration) return;
      const pageMatches = findMatchesInPage(index, pageNumber - 1, query);
      if (pageMatches.length) collected.push(...pageMatches);
    }
    if (generation !== searchGeneration) return;
    searchBusy = false;
    searchMatches = collected;
    indexMatchesByPage(collected);
    if (collected.length > 0) {
      focusMatch(0);
    } else {
      activeMatchIndex = 0;
      activeSearchMatchId = null;
      searchVersion += 1;
    }
  }

  function focusMatch(index: number) {
    if (searchMatches.length === 0) return;
    const wrapped =
      ((index % searchMatches.length) + searchMatches.length) %
      searchMatches.length;
    activeMatchIndex = wrapped;
    const match = searchMatches[wrapped];
    activeSearchMatchId = match.id;
    searchVersion += 1;
    scrollToPage(match.pageIndex + 1);
    // The page may still be rendering; if its overlay is already present,
    // centre the exact hit, otherwise the page-level scroll is enough.
    requestAnimationFrame(() => {
      const el = container?.querySelector<HTMLElement>(
        `[data-search-match-id="${CSS.escape(match.id)}"]`
      );
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  function nextMatch() {
    focusMatch(activeMatchIndex + 1);
  }

  function previousMatch() {
    focusMatch(activeMatchIndex - 1);
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

  async function exportCurrentPdfNote() {
    try {
      await flushSave();
      await exportAnnotatedPdfNote(noteId);
    } catch (err) {
      console.error('[PdfNoteViewer] export failed', err);
      await alert({
        title: 'Annotated PDF export failed',
        message: err instanceof Error ? err.message : String(err)
      });
    }
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
      case 'editor.pdf.undo':
        if (!isTrashed) undo();
        return true;
      case 'editor.pdf.redo':
        if (!isTrashed) redo();
        return true;
      case 'editor.pdf.toggleComments':
        commentsSidebarOpen = !commentsSidebarOpen;
        return true;
      case 'editor.pdf.toggleNavigator':
        toggleNavigator();
        return true;
      case SEARCH_ACTIVE_NOTE_COMMAND:
        openSearch();
        return true;
      case 'editor.pdf.previousPage':
        goToPreviousPage();
        return true;
      case 'editor.pdf.nextPage':
        goToNextPage();
        return true;
      case 'editor.pdf.export':
        void exportCurrentPdfNote();
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
      bumpRenderVersion();
      // Drives fit-width placeholder sizing reactively. Without this,
      // placeholder dimensions go stale on window resize even though the
      // canvases redraw fine via the renderVersion bump.
      containerWidth = node.clientWidth;
    });
    resizeObserver.observe(node);
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
    mobileToolbar = isMobile();
    savedSignatures = loadReusableSignatures();
    activeSignatureId = savedSignatures[0]?.id ?? null;
    await tick();
    if (hostEl) {
      editorListener = {
        kind: 'pdf',
        host: hostEl,
        noteId,
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

      // Undo/redo scoped to this note's annotations. trackedOrigins is
      // limited to LOCAL_ORIGIN so undo never reverts a peer's edit or a
      // sync merge — only changes this client authored.
      undoManager = new Y.UndoManager(annotationsMap, {
        trackedOrigins: new Set([LOCAL_ORIGIN])
      });
      const refreshUndoState = () => {
        canUndo = (undoManager?.undoStack.length ?? 0) > 0;
        canRedo = (undoManager?.redoStack.length ?? 0) > 0;
      };
      undoManager.on('stack-item-added', refreshUndoState);
      undoManager.on('stack-item-popped', refreshUndoState);
      undoManager.on('stack-cleared', refreshUndoState);

      // Awareness goes alongside the Y.Doc — the CollabProvider takes
      // both as constructor args. Seed the local user field now so peers
      // see our name + colour as soon as we join the room.
      const localAwareness = new Awareness(localYDoc);
      awareness = localAwareness;
      try {
        const session = await etebaseSession();
        const userName = session?.username ?? 'You';
        // Stamp new annotations with the real username so authors are
        // attributable across collaborators (not all "local").
        if (session?.username) localAuthorId = session.username;
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
      // Document outline (bookmarks) for the navigator's Outline tab.
      // Resolved off the load path; the tab simply stays empty until ready.
      void loadFlatOutline(pdfDoc).then((items) => {
        outline = items;
      });
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

  // Local keyboard handling that shouldn't go through the hotkey bus:
  //  - Escape closes the find bar from anywhere in the viewer.
  //  - Delete/Backspace removes the selected annotation, but only when
  //    focus isn't in a text field (so editing a comment still works).
  // (Opening find is the app-level "search active note" bus command.)
  $effect(() => {
    if (!hostEl) return;
    const host = hostEl;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && searchOpen) {
        closeSearch();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (isTrashed || !selectedAnnotationId) return;
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          target?.isContentEditable
        ) {
          return;
        }
        event.preventDefault();
        deleteAnnotation(selectedAnnotationId);
      }
    };
    host.addEventListener('keydown', onKeydown);
    return () => host.removeEventListener('keydown', onKeydown);
  });

  onDestroy(() => {
    if (saveTimer) {
      void flushSave();
    }
    saveReady = false;
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    searchGeneration += 1;
    textIndexCache.clear();
    searchMatchesByPage.clear();
    pageViewports.clear();
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
    undoManager?.destroy();
    undoManager = null;
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
    // Link annotations for this page (external URLs + internal jumps),
    // fetched once per draw and overlaid as clickable anchors.
    let currentLinks: PdfLink[] = [];
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

    // Search-hit overlay: translucent boxes over every match on this page,
    // with the active hit emphasised. Read imperatively from the parent's
    // per-page match map; the `searchVersion` param triggers the refresh.
    function renderSearchLayer() {
      const pageEl = pageSurface.querySelector<HTMLElement>('.page');
      const viewport = currentViewport;
      if (!pageEl || !viewport) return;
      pageEl.querySelector('.pdf-search-layer')?.remove();
      const matches = searchMatchesByPage.get(current.pageNumber - 1);
      if (!matches || matches.length === 0) return;
      const layer = document.createElement('div');
      layer.className = 'pdf-search-layer';
      for (const match of matches) {
        for (const rect of match.rects) {
          const [x1, y1] = viewport.convertToViewportPoint(rect.x, rect.y);
          const [x2, y2] = viewport.convertToViewportPoint(
            rect.x + rect.width,
            rect.y + rect.height
          );
          const node = document.createElement('div');
          node.className = 'pdf-search-hit';
          if (match.id === activeSearchMatchId) {
            node.classList.add('pdf-search-hit-active');
          }
          node.dataset.searchMatchId = match.id;
          node.style.left = `${Math.min(x1, x2)}px`;
          node.style.top = `${Math.min(y1, y2)}px`;
          node.style.width = `${Math.abs(x2 - x1)}px`;
          node.style.height = `${Math.abs(y2 - y1)}px`;
          layer.append(node);
        }
      }
      pageEl.append(layer);
    }

    // Clickable overlay for the page's link annotations. Sits below the
    // app-annotation layer, so links are only hit in select mode (when
    // that layer passes pointer events through).
    function renderLinkLayer() {
      const pageEl = pageSurface.querySelector<HTMLElement>('.page');
      const viewport = currentViewport;
      if (!pageEl || !viewport) return;
      pageEl.querySelector('.pdf-link-layer')?.remove();
      if (currentLinks.length === 0) return;
      const layer = document.createElement('div');
      layer.className = 'pdf-link-layer';
      for (const link of currentLinks) {
        if (!Array.isArray(link.rect) || link.rect.length < 4) continue;
        const [x1, y1] = viewport.convertToViewportPoint(
          link.rect[0],
          link.rect[1]
        );
        const [x2, y2] = viewport.convertToViewportPoint(
          link.rect[2],
          link.rect[3]
        );
        const node = document.createElement(link.url ? 'a' : 'button');
        node.className = 'pdf-link';
        node.style.left = `${Math.min(x1, x2)}px`;
        node.style.top = `${Math.min(y1, y2)}px`;
        node.style.width = `${Math.abs(x2 - x1)}px`;
        node.style.height = `${Math.abs(y2 - y1)}px`;
        if (link.url) {
          const anchor = node as HTMLAnchorElement;
          anchor.href = link.url;
          anchor.title = link.url;
          anchor.rel = 'noopener noreferrer';
          anchor.addEventListener('click', (event) => {
            event.preventDefault();
            void openExternalUrl(link.url as string);
          });
        } else {
          node.addEventListener('click', (event) => {
            event.preventDefault();
            void followLinkDest(link.dest);
          });
        }
        layer.append(node);
      }
      pageEl.append(layer);
    }

    function renderAppAnnotations() {
      const pageEl = pageSurface.querySelector<HTMLElement>('.page');
      const viewport = currentViewport;
      if (!pageEl || !viewport) return;

      renderLinkLayer();
      renderSearchLayer();

      pageEl.querySelector('.pdf-app-annotation-layer')?.remove();
      const layer = document.createElement('div');
      layer.className = 'pdf-app-annotation-layer';
      // Text-aware modes (select, plus highlight/comment when NOT in area
      // mode) let pointer events fall through to the text layer so the
      // user can select words; everything else captures drags to draw.
      const textMode =
        current.activeTool === 'select' ||
        ((current.activeTool === 'highlight' ||
          current.activeTool === 'comment') &&
          !current.areaMode);
      layer.style.pointerEvents = textMode || isTrashed ? 'none' : 'auto';
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
          previewStroke.setAttribute('stroke', inkColor);
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
                  color: inkColor,
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

      // Drag-to-draw a rectangle is for signatures and for highlight/comment
      // only in area mode. In text mode highlight/comment come from the
      // selection (see the selection effect), so no drag handler here.
      const wantsAreaDraw =
        current.activeTool === 'signature' ||
        ((current.activeTool === 'highlight' ||
          current.activeTool === 'comment') &&
          current.areaMode);
      if (!wantsAreaDraw) {
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
          const activeSignature =
            annotationType === 'signature' ? getActiveSignature() : null;
          const signature =
            annotationType === 'signature' && activeSignature
              ? cloneSignatureSnapshot(activeSignature)
              : undefined;
          if (annotationType === 'signature' && !signature) return;
          // Comments are created empty; the sidebar editor opens focused
          // for the body (see commentDraftFocusId), replacing window.prompt.
          createAnnotation(
            annotationType,
            current.pageNumber - 1,
            rect,
            undefined,
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
      // Expose the rendered viewport so text-selection client-rects can be
      // mapped back into PDF user space for text-aware annotations.
      pageViewports.set(request.pageNumber, viewport);

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
        // Link annotations for the clickable overlay. Best-effort: a
        // failure here shouldn't stop the page from rendering.
        try {
          const annots = await page.getAnnotations({ intent: 'display' });
          if (cancelled || generation !== drawGeneration) return;
          currentLinks = annots
            .filter((a: { subtype?: string }) => a.subtype === 'Link')
            .map((a: { rect: number[]; url?: string; dest?: unknown }) => ({
              rect: a.rect,
              url: a.url,
              dest: a.dest as string | unknown[] | null | undefined
            }));
        } catch {
          currentLinks = [];
        }
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
      aria-label={tUi('pdf.toolbar.label')}
      class="shrink-0 justify-between border-b border-border bg-background"
    >
      <div class="flex items-center gap-0.5">
        <ToolbarButton
          active={navigatorOpen}
          onclick={toggleNavigator}
          aria-label={tUi('pdf.toolbar.navigator')}
          title={tUi('pdf.toolbar.navigator')}
          aria-pressed={navigatorOpen}
        >
          <PanelLeft aria-hidden="true" />
        </ToolbarButton>

        <ToolbarSeparator />

        <ToolbarButton
          active={activeTool === 'select'}
          onclick={() => setTool('select')}
          aria-label={tUi('pdf.toolbar.select')}
          title={tUi('pdf.toolbar.select')}
          aria-pressed={activeTool === 'select'}
        >
          <TextCursor aria-hidden="true" />
        </ToolbarButton>

        <ToolbarButton
          active={activeTool === 'highlight'}
          onclick={() => setTool('highlight')}
          aria-label={tUi('pdf.toolbar.highlight')}
          title={tUi('pdf.toolbar.highlight')}
          aria-pressed={activeTool === 'highlight'}
          disabled={isTrashed}
        >
          <Highlighter aria-hidden="true" />
        </ToolbarButton>

        <ToolbarButton
          active={activeTool === 'comment'}
          onclick={() => setTool('comment')}
          aria-label={tUi('pdf.toolbar.comment')}
          title={tUi('pdf.toolbar.comment')}
          aria-pressed={activeTool === 'comment'}
          disabled={isTrashed}
        >
          <MessageSquarePlus aria-hidden="true" />
        </ToolbarButton>

        <ToolbarButton
          active={activeTool === 'pen'}
          onclick={() => setTool('pen')}
          aria-label={tUi('pdf.toolbar.pen')}
          title={tUi('pdf.toolbar.pen')}
          aria-pressed={activeTool === 'pen'}
          disabled={isTrashed}
        >
          <PenLine aria-hidden="true" />
        </ToolbarButton>

        <ToolbarButton
          bind:ref={signatureButton}
          active={activeTool === 'signature'}
          onclick={() => setTool('signature')}
          aria-label={tUi('pdf.toolbar.sign')}
          title={tUi('pdf.toolbar.sign')}
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
          aria-label={tUi('pdf.toolbar.delete')}
          title={tUi('pdf.toolbar.delete')}
          aria-pressed={activeTool === 'delete'}
          disabled={isTrashed}
        >
          <Trash2 aria-hidden="true" />
        </ToolbarButton>

        {#if activeTool === 'highlight' || activeTool === 'comment' || activeTool === 'pen'}
          <ToolbarSeparator />
        {/if}

        {#if activeTool === 'highlight' || activeTool === 'comment'}
          <ToolbarButton
            active={areaMode}
            onclick={() => (areaMode = !areaMode)}
            aria-label={tUi('pdf.toolbar.area')}
            title={tUi('pdf.toolbar.area')}
            aria-pressed={areaMode}
            disabled={isTrashed}
          >
            <SquareDashed aria-hidden="true" />
          </ToolbarButton>
        {/if}

        {#if activeTool === 'highlight' || activeTool === 'pen'}
          <div
            class="flex items-center gap-1 px-1"
            role="group"
            aria-label={tUi('pdf.toolbar.color')}
          >
            {#each ANNOTATION_COLORS as color (color)}
              <button
                type="button"
                class="size-5 rounded-full transition hover:scale-110"
                style="background-color: {color}; box-shadow: {activeColor ===
                color
                  ? '0 0 0 2px var(--ring)'
                  : '0 0 0 1px var(--border)'}"
                aria-label={tUi('pdf.toolbar.colorSwatch').replace(
                  '{color}',
                  color
                )}
                aria-pressed={activeColor === color}
                onclick={() => setActiveColor(color)}
              ></button>
            {/each}
          </div>
        {/if}

        <ToolbarSeparator />

        <ToolbarButton
          onclick={undo}
          disabled={isTrashed || !canUndo}
          aria-label={tUi('pdf.toolbar.undo')}
          title={tUi('pdf.toolbar.undo')}
        >
          <Undo2 aria-hidden="true" />
        </ToolbarButton>

        <ToolbarButton
          onclick={redo}
          disabled={isTrashed || !canRedo}
          aria-label={tUi('pdf.toolbar.redo')}
          title={tUi('pdf.toolbar.redo')}
        >
          <Redo2 aria-hidden="true" />
        </ToolbarButton>

        <ToolbarSeparator />

        <ToolbarButton
          active={commentsSidebarOpen}
          onclick={() => (commentsSidebarOpen = !commentsSidebarOpen)}
          aria-label={tUi('pdf.toolbar.comments')}
          title={tUi('pdf.toolbar.comments')}
          aria-pressed={commentsSidebarOpen}
        >
          <MessagesSquare aria-hidden="true" />
        </ToolbarButton>
      </div>

      <div class="flex items-center gap-0.5">
        <ToolbarButton
          onclick={goToPreviousPage}
          disabled={activePageNumber <= 1}
          aria-label={tUi('pdf.toolbar.previousPage')}
          title={tUi('pdf.toolbar.previousPage')}
        >
          <ChevronLeft aria-hidden="true" />
        </ToolbarButton>

        <div class="flex items-center gap-1 text-xs text-muted-foreground">
          <input
            type="text"
            inputmode="numeric"
            value={pageInputValue}
            aria-label={tUi('pdf.page.inputLabel')}
            class="h-7 w-9 rounded-md border border-border bg-background text-center tabular-nums outline-none focus:ring-1 focus:ring-ring"
            oninput={(event) =>
              (pageInputValue = (event.currentTarget as HTMLInputElement)
                .value)}
            onfocus={(event) => {
              pageInputFocused = true;
              (event.currentTarget as HTMLInputElement).select();
            }}
            onblur={() => {
              pageInputFocused = false;
              commitPageInput();
            }}
            onkeydown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                (event.currentTarget as HTMLInputElement).blur();
              }
            }}
          />
          <span class="tabular-nums">
            {tUi('pdf.page.totalLabel').replace(
              '{total}',
              String(pageNumbers.length)
            )}
          </span>
        </div>

        <ToolbarButton
          onclick={goToNextPage}
          disabled={activePageNumber >= pageNumbers.length}
          aria-label={tUi('pdf.toolbar.nextPage')}
          title={tUi('pdf.toolbar.nextPage')}
        >
          <ChevronRight aria-hidden="true" />
        </ToolbarButton>

        {#if !mobileToolbar}
          <ToolbarSeparator />

          <ToolbarZoomControls
            bind:open={zoomMenuOpen}
            label={zoomLabel}
            zoomOutLabel={tUi('pdf.toolbar.zoomOut')}
            zoomInLabel={tUi('pdf.toolbar.zoomIn')}
            zoomMenuLabel={tUi('pdf.toolbar.zoom')}
            fitLabel={tUi('pdf.toolbar.fitWidth')}
            fitActive={zoomMode === 'fit-width'}
            zoomOptions={QUICK_ZOOMS}
            selectedZoom={zoomMode === 'fixed' ? zoom : null}
            onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
            onZoomIn={() => zoomBy(ZOOM_STEP)}
            onFit={setFitWidthZoom}
            onSelectZoom={setFixedZoom}
          />
        {/if}
      </div>
    </Toolbar>

    {#if searchOpen}
      <FindBar
        bind:this={searchBar}
        query={searchQuery}
        matchCount={searchMatches.length}
        activeIndex={activeMatchIndex}
        busy={searchBusy}
        onInput={handleSearchInput}
        onNext={nextMatch}
        onPrevious={previousMatch}
        onClose={closeSearch}
      />
    {/if}

    <div class="flex min-h-0 flex-1 overflow-hidden">
      {#if navigatorOpen && pdfDoc}
        <PdfNavigatorSidebar
          {pdfDoc}
          pageCount={pageNumbers.length}
          {pageSizes}
          {activePageNumber}
          {outline}
          onJump={(page) => scrollToPage(page)}
          onClose={() => (navigatorOpen = false)}
        />
      {/if}

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
            {@const pageCaption = tUi('pdf.page.caption')
              .replace('{page}', String(pageNumber))
              .replace('{total}', String(pageNumbers.length))}
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
                  areaMode,
                  selectedAnnotationId,
                  shouldRender,
                  invalidation,
                  searchVersion
                }}
                style="width:{size.width}px; height:{size.height}px"
                class="pdf-page-host pdfViewer bg-white shadow-sm ring-1 ring-border"
              ></div>
              <figcaption
                class="flex items-center gap-1 text-[10px] text-muted-foreground"
              >
                <FileText class="size-3" aria-hidden="true" />
                {pageCaption}
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
          currentAuthorId={localAuthorId}
          autofocusId={commentDraftFocusId}
          onJump={jumpToAnnotation}
          onUpdate={updateAnnotation}
          onDelete={deleteAnnotation}
          onAutofocusHandled={() => (commentDraftFocusId = null)}
          onClose={() => (commentsSidebarOpen = false)}
        />
      {/if}
    </div>

    {#if selectionMenu && activeTool === 'select' && !isTrashed}
      <PdfSelectionMenu
        x={selectionMenu.x}
        y={selectionMenu.y}
        onHighlight={highlightSelection}
        onComment={commentSelection}
      />
    {/if}

    {#if annotationMenu && selectedAnnotation && !isTrashed}
      <PdfAnnotationMenu
        x={annotationMenu.x}
        y={annotationMenu.y}
        canAddComment={selectedAnnotation.type === 'highlight' &&
          typeof selectedAnnotation.body !== 'string'}
        colorable={selectedAnnotation.type === 'highlight' ||
          selectedAnnotation.type === 'comment'}
        colors={ANNOTATION_COLORS}
        activeColor={selectedAnnotation.color}
        onAddComment={addCommentToSelected}
        onPickColor={recolorSelected}
        onDelete={deleteSelectedAnnotation}
      />
    {/if}

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

  /* Link overlay: sits above the canvas/text but below the annotation
     layer (z-index 3), so links are only clickable in select mode when
     that layer passes pointer events through. */
  :global(.pdf-page-host .pdf-link-layer) {
    position: absolute;
    inset: 0;
    z-index: 2;
    overflow: clip;
    /* The layer spans the whole page above the text layer; without this
       it would swallow pointer events and block text selection. Only the
       individual link hotspots re-enable pointer events. */
    pointer-events: none;
  }

  :global(.pdf-page-host .pdf-link) {
    position: absolute;
    display: block;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    border-radius: 2px;
    cursor: pointer;
    pointer-events: auto;
  }

  :global(.pdf-page-host .pdf-link:hover) {
    background: color-mix(in srgb, var(--ring) 18%, transparent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--ring) 55%, transparent);
  }

  /* Search-hit overlay: non-interactive translucent boxes. */
  :global(.pdf-page-host .pdf-search-layer) {
    position: absolute;
    inset: 0;
    z-index: 2;
    overflow: clip;
    pointer-events: none;
  }

  :global(.pdf-page-host .pdf-search-hit) {
    position: absolute;
    border-radius: 1px;
    background: rgb(250 204 21 / 0.42);
    mix-blend-mode: multiply;
  }

  :global(.pdf-page-host .pdf-search-hit-active) {
    background: rgb(249 115 22 / 0.55);
    box-shadow: 0 0 0 1px rgb(234 88 12 / 0.9);
  }
</style>
