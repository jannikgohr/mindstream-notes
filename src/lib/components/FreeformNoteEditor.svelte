<script lang="ts">
  /**
   * Drawing-canvas editor for `note_kind === 'freeform'` notes.
   *
   * Architecture mirrors NoteEditor: a Y.Doc backs the document, the same
   * CollabProvider attaches it to the live-collab relay, and saves run on
   * a debounced yDoc 'update' hook so local + remote edits both persist.
   * What differs is the doc's shape — instead of a y-prosemirror
   * XmlFragment, we own a single `Y.Array<StrokeRecord>` named 'strokes'.
   * Each completed stroke (pointer-up boundary) is pushed as one item,
   * which makes the atomic collab event "one new stroke" and gives us a
   * natural hook for future OCR / erase-by-stroke without changing the
   * persistence shape.
   *
   * Persistence reuses the existing `yrs_state` column unchanged — the
   * Rust side doesn't care what's inside the encoded Y.Doc, only that it
   * round-trips. Crepe/y-prosemirror's `payload_schema = 2` flip from
   * NoteEditor.update is harmless here (the Doc just happens to be a
   * Y.Array, not an XmlFragment).
   *
   * Coordinates: canvas-local CSS pixels, integers in `[0, CANVAS_W) /
   * [0, CANVAS_H)`. Reading a stroke later (OCR / vector export) doesn't
   * need any transform.
   *
   * Out of scope for this slice (deliberately):
   *   - HiDPI / devicePixelRatio handling (drawing looks fine, just not
   *     as crisp on retina; trivially added later)
   *   - Pressure curves (`PointerEvent.pressure` is already on the event,
   *     just not stored — StrokeRecord has a reserved `pressure?` field)
   *   - Eraser, highlighter, multiple colors, undo/redo
   *   - Pan / zoom of the canvas
   *   - Local OCR (the per-stroke shape + pointerup boundary is the hook)
   */

  import { onDestroy, onMount } from 'svelte';
  import * as Y from 'yjs';
  import { Awareness } from 'y-protocols/awareness';
  import { Trash2, Wifi, WifiOff } from 'lucide-svelte';
  import {
    loadNote,
    saveNote as apiSaveNote,
    TRASH_ID,
    noteRoomInfo,
    etebaseSession,
    onSessionChange
  } from '$lib/api';
  import { tree } from '$lib/stores/tree.svelte';
  import { getSettingValue } from '$lib/settings/store.svelte';
  import { CollabProvider } from '$lib/sync/collab-provider';

  interface Props {
    noteId: string;
  }
  let { noteId }: Props = $props();

  /** Stroke shape persisted into the Y.Array. Reserved fields exist as
   *  optional so future versions can introduce them without breaking
   *  decoding of older strokes. */
  interface StrokeRecord {
    id: string;
    points: [number, number][];
    color: string;
    width: number;
    pressure?: number[];
    tool?: 'pen' | 'highlighter';
  }

  // Fixed canvas dimensions — a sensible "page" size. The container
  // scrolls; absolute coords inside the canvas are what we persist.
  // HiDPI / pan / zoom can layer on without changing this contract.
  const CANVAS_W = 1600;
  const CANVAS_H = 1200;

  // Single tool for v1.
  const PEN_COLOR = '#1c1c1c';
  const PEN_WIDTH = 2;

  /** Debounce window for save scheduling — same as NoteEditor. */
  const SAVE_DEBOUNCE_MS = 800;

  let canvas: HTMLCanvasElement | null = $state(null);
  let ctx: CanvasRenderingContext2D | null = null;

  let yDoc: Y.Doc | null = null;
  let yStrokes: Y.Array<StrokeRecord> | null = null;
  let awareness: Awareness | null = null;

  let provider: CollabProvider | null = null;
  let collabOnline = $state(false);
  let collabConfigured = $state(false);

  /** Stroke currently under the user's pointer — not yet in `yStrokes`.
   *  Committed on pointerup; rendered every frame on top of the
   *  Y.Array-backed strokes. */
  let activeStroke: StrokeRecord | null = null;

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let savingState = $state<'idle' | 'pending' | 'saving' | 'saved' | 'error'>(
    'idle'
  );
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  let yDocUpdateHandler: (() => void) | null = null;
  let yStrokesObserver: (() => void) | null = null;
  /** Gate yDoc updates from triggering saves until hydration is done —
   *  same idea as the saveReady flag in NoteEditor. */
  let saveReady = false;

  // ---- Trash detection — identical to NoteEditor, kept inline rather
  // than extracted because it depends on tree's reactive shape. ----

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

  // ---- Mount ----

  let lastSeenPushed = false;
  let collabReady = false;
  let unsubSession: (() => void) | null = null;

  onMount(async () => {
    if (!canvas) return;
    try {
      const note = await loadNote(noteId);
      if (!canvas) return; // unmounted while awaiting

      yDoc = new Y.Doc();
      if (note.yrs_state.length > 0) {
        try {
          Y.applyUpdate(yDoc, new Uint8Array(note.yrs_state));
        } catch (err) {
          console.warn('[FreeformNoteEditor] yrs_state hydration failed', err);
        }
      }
      yStrokes = yDoc.getArray<StrokeRecord>('strokes');

      awareness = new Awareness(yDoc);
      try {
        const session = await etebaseSession();
        const userName = session?.username ?? 'You';
        awareness.setLocalStateField('user', { name: userName });
      } catch (err) {
        console.debug('[FreeformNoteEditor] no session for awareness', err);
      }

      ctx = canvas.getContext('2d');
      redraw();

      // Re-render whenever the Y.Array changes — local pushes AND remote
      // updates apply through the same observer, so collab edits paint
      // automatically without a separate code path.
      yStrokesObserver = () => redraw();
      yStrokes.observe(yStrokesObserver);

      // Same save trigger as NoteEditor: yDoc 'update' fires for every
      // mutation (local + remote-applied), giving us a single hook to
      // debounce-save against. We don't use a listener plugin for strokes;
      // direct yDoc updates are simpler and sufficient here.
      yDocUpdateHandler = () => {
        if (!saveReady) return;
        scheduleSave();
      };
      yDoc.on('update', yDocUpdateHandler);
      saveReady = true;

      lastSeenPushed = tree.notesById[noteId]?.pushed ?? false;
      await setupCollabProvider();
      collabReady = true;

      unsubSession = onSessionChange(() => {
        void setupCollabProvider();
      });

      loading = false;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      loading = false;
      console.error('[FreeformNoteEditor] load failed', err);
    }
  });

  $effect(() => {
    const pushed = tree.notesById[noteId]?.pushed ?? false;
    if (!collabReady) return;
    if (pushed === lastSeenPushed) return;
    lastSeenPushed = pushed;
    void setupCollabProvider();
  });

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
      console.debug('[FreeformNoteEditor] collab provider init failed', err);
    }
  }

  onDestroy(() => {
    if (saveTimer) clearTimeout(saveTimer);
    unsubSession?.();
    unsubSession = null;
    saveReady = false;
    if (yDoc && yDocUpdateHandler) yDoc.off('update', yDocUpdateHandler);
    if (yStrokes && yStrokesObserver) yStrokes.unobserve(yStrokesObserver);
    yDocUpdateHandler = null;
    yStrokesObserver = null;
    provider?.destroy();
    provider = null;
    collabOnline = false;
    collabConfigured = false;
    awareness?.destroy();
    awareness = null;
    yStrokes = null;
    yDoc?.destroy();
    yDoc = null;
    ctx = null;
  });

  // ---- Drawing ----

  function redraw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    // Paper background. Kept inside the redraw (not a CSS background) so
    // it's part of the exportable bitmap if we ever add image export.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    if (yStrokes) {
      for (const s of yStrokes.toArray()) drawStroke(s);
    }
    if (activeStroke) drawStroke(activeStroke);
  }

  function drawStroke(s: StrokeRecord) {
    if (!ctx || s.points.length === 0) return;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const [x0, y0] = s.points[0];
    ctx.moveTo(x0, y0);
    for (let i = 1; i < s.points.length; i++) {
      const [x, y] = s.points[i];
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // ---- Pointer handling ----

  /** Map a pointer event to the canvas's own CSS-pixel coordinate system.
   *  Uses getBoundingClientRect each time so window resize, container
   *  scroll, and panel splits all stay correct without extra plumbing. */
  function clientToCanvas(e: PointerEvent): [number, number] {
    if (!canvas) return [0, 0];
    const rect = canvas.getBoundingClientRect();
    const x = Math.round(e.clientX - rect.left);
    const y = Math.round(e.clientY - rect.top);
    return [x, y];
  }

  function onPointerDown(e: PointerEvent) {
    if (isTrashed || !canvas) return;
    // Capture so a fast off-canvas drag still routes pointermove/up here
    // (otherwise the stroke gets stranded mid-flight if the user leaves
    // the canvas while drawing).
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = clientToCanvas(e);
    activeStroke = {
      id: newStrokeId(),
      points: [[x, y]],
      color: PEN_COLOR,
      width: PEN_WIDTH
    };
    redraw();
  }

  function onPointerMove(e: PointerEvent) {
    if (!activeStroke) return;
    const [x, y] = clientToCanvas(e);
    const last = activeStroke.points[activeStroke.points.length - 1];
    // Drop redundant points — moving slowly produces a flood of
    // same-pixel events on touch hardware and bloats yrs_state for no
    // visible benefit.
    if (last && last[0] === x && last[1] === y) return;
    activeStroke.points.push([x, y]);
    redraw();
  }

  function onPointerUp(e: PointerEvent) {
    if (!activeStroke || !yStrokes || !canvas) return;
    canvas.releasePointerCapture(e.pointerId);
    // Single-tap (no movement) is treated as nothing — avoids littering
    // the canvas with 1-pixel "dots" from accidental taps. A real "dot"
    // tool with deliberate UX can come later.
    if (activeStroke.points.length > 1) {
      // One pointerup = one atomic Y.Array push = one collab frame.
      // Treat the object as immutable from here on; don't mutate it after
      // pushing, Yjs has already encoded it.
      yStrokes.push([activeStroke]);
    }
    activeStroke = null;
    redraw();
  }

  function newStrokeId(): string {
    // Prefer the platform RNG; fall back to a coarse alternative for
    // ancient webviews that don't expose randomUUID.
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `s_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  }

  // ---- Save (debounced) ----

  function scheduleSave() {
    if (isTrashed) return;
    savingState = 'pending';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        savingState = 'saving';
        const yrsState = yDoc
          ? Array.from(Y.encodeStateAsUpdate(yDoc))
          : undefined;
        // body is intentionally empty for freeform notes — there's no
        // markdown to render. Future: OCR text could land here for
        // full-text search.
        await apiSaveNote({
          id: noteId,
          body: '',
          yrs_state: yrsState
        });
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
        console.error('[FreeformNoteEditor] save failed', err);
      }
    }, SAVE_DEBOUNCE_MS);
  }

  function base64ToBytes(b64: string): Uint8Array {
    const standard = b64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const statusLabel = $derived.by(() => {
    if (isTrashed) return 'Read-only';
    switch (savingState) {
      case 'pending': return 'Editing…';
      case 'saving': return 'Saving…';
      case 'saved': return 'Saved';
      case 'error': return 'Save failed';
      default: return '';
    }
  });
</script>

<div class="flex h-full w-full flex-col">
  {#if !isTrashed}
    <div
      class="flex h-5 shrink-0 items-center justify-end gap-2 px-3 text-[10px] uppercase tracking-wider text-muted-foreground"
      aria-live="polite"
    >
      {#if collabConfigured}
        {#if collabOnline}
          <span class="flex items-center gap-1 text-emerald-600 dark:text-emerald-400" title="Live collab connected">
            <Wifi class="size-3" aria-hidden="true" />
            Live
          </span>
        {:else}
          <span class="flex items-center gap-1" title="Live collab disconnected — reconnecting">
            <WifiOff class="size-3" aria-hidden="true" />
            Offline
          </span>
        {/if}
      {/if}
      <span>{statusLabel}</span>
    </div>
  {/if}
  {#if isTrashed}
    <div
      class="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive"
      role="status"
    >
      <Trash2 class="size-3.5 shrink-0" aria-hidden="true" />
      <span>This note is in the trash and is read-only. Restore it to edit.</span>
    </div>
  {/if}
  <div class="themed-scrollbar relative min-h-0 w-full flex-1 overflow-auto bg-muted/40 p-4">
    {#if loading}
      <p class="px-2 py-2 text-sm text-muted-foreground">Loading drawing…</p>
    {:else if loadError}
      <p class="px-2 py-2 text-sm text-destructive">Couldn't load drawing: {loadError}</p>
    {/if}
    <canvas
      bind:this={canvas}
      width={CANVAS_W}
      height={CANVAS_H}
      class="mx-auto block rounded-md border border-border bg-white shadow-sm"
      style="touch-action: none;"
      class:pointer-events-none={isTrashed}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
    ></canvas>
  </div>
</div>
