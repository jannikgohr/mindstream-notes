<script lang="ts">
  /**
   * Freeform / drawing editor for `note_kind === 'freeform'` notes.
   *
   * Architecture: this Svelte component is just the shell — it owns the
   * Y.Doc, the CollabProvider (live E2EE relay socket), persistence
   * (debounced save), and trashed-state detection. The actual drawing
   * surface is tldraw, mounted as a React island inside this shell.
   * React + tldraw + the bridge are dynamically imported so they only
   * pay their bundle cost (~750 KB gz) when a drawing note is opened.
   *
   * Doc shape: a tldraw `TLStore` mapped onto a single `Y.Map<TLRecord>`
   * via the bridge in `$lib/freeform/tldraw-yjs.ts`. The Rust persistence
   * pipeline doesn't care — `yrs_state` round-trips opaque bytes. The
   * relay sees only encrypted Yjs updates (same E2EE story as the
   * markdown editor).
   *
   * Mobile: tldraw has touch handling built in (pan, pinch, draw). The
   * existing mobile formatting toolbar only mounts inside markdown notes,
   * so there's no conflict here.
   *
   * Deferred follow-ups (intentional):
   *   - Asset upload (image drop) routes through Etebase as opaque
   *     encrypted Items. The island ships with a stub assetStore that
   *     errors loudly on upload so the failure mode is obvious.
   *   - Presence (remote cursors). Awareness instance is wired into the
   *     island already; the bridge just doesn't read from it yet.
   */

  import { onDestroy, onMount, untrack } from 'svelte';
  import * as Y from 'yjs';
  import { Awareness } from 'y-protocols/awareness';
  import { Trash2, Wifi, WifiOff } from 'lucide-svelte';
  import { userPrefersMode } from 'mode-watcher';
  import {
    loadNote,
    saveNote as apiSaveNote,
    TRASH_ID,
    noteRoomInfo,
    etebaseSession,
    onSessionChange
  } from '$lib/api';
  import { tree } from '$lib/stores/tree.svelte';
  import {
    setNoteStatus,
    clearNoteStatus
  } from '$lib/stores/note-status.svelte';
  import { getSettingValue } from '$lib/settings/store.svelte';
  import { CollabProvider } from '$lib/sync/collab-provider';
  import { isMobile } from '$lib/platform';
  import { listen } from '$lib/api/events';

  interface Props {
    noteId: string;
  }
  let { noteId }: Props = $props();

  /** Debounce window for save scheduling — same as NoteEditor. */
  const SAVE_DEBOUNCE_MS = 800;

  /** Mount point for the React island. dockview gives us the full panel;
   *  the island fills it via `position: absolute; inset: 0`. */
  let mountEl: HTMLDivElement | null = $state(null);
  // isMobile() reads navigator.userAgent — unavailable during SSR, so
  // resolve in onMount. Same dance as NoteEditor.svelte. Drives whether
  // the inline Saved/Editing/Live indicator renders (mobile only) vs
  // pushes to the global note-status store for the dockview header.
  let mobile = $state(false);

  let yDoc: Y.Doc | null = null;
  let awareness: Awareness | null = null;

  let provider: CollabProvider | null = null;
  let collabOnline = $state(false);
  let collabConfigured = $state(false);

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let savingState = $state<'idle' | 'pending' | 'saving' | 'saved' | 'error'>(
    'idle'
  );
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  let yDocUpdateHandler: (() => void) | null = null;
  /** Gate yDoc updates from triggering saves until hydration is done. */
  let saveReady = false;

  // React island handles — typed as `unknown` because react-dom and the
  // island module are dynamic imports; the precise types aren't loaded
  // into the markdown / app-shell bundle.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let reactRoot: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let TldrawIslandComponent: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let reactCreateElement: any = null;

  // ---- Trash detection (mirrors NoteEditor) ----

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

  /** Stylus / pen-mode preference, sourced from settings and re-evaluated
   *  reactively so toggling the setting from the dialog flows into the
   *  open canvas without a remount. Narrowed to the union the island
   *  expects; falls back to 'auto' if the cache hasn't hydrated yet. */
  const penMode = $derived.by<'auto' | 'always' | 'off'>(() => {
    const v = getSettingValue('editor.freeform.penMode');
    if (v === 'always' || v === 'off') return v;
    return 'auto';
  });

  // ---- Mount ----

  let lastSeenPushed = false;
  let collabReady = false;
  let unsubSession: (() => void) | null = null;
  /** Tauri sync-completed subscription. Same idea as in NoteEditor:
   *  when sync pulls a fresh yrs_state for THIS note, we merge it into
   *  the open Y.Doc via Y.applyUpdate (Yjs CRDT-safe). Asset
   *  invalidation for tldraw lives inside the React island so it can
   *  re-put store records directly. */
  let unsubSync: (() => void) | null = null;

  onMount(async () => {
    if (!mountEl) return;
    try {
      mobile = isMobile();
      const note = await loadNote(noteId);
      if (!mountEl) return; // unmounted while awaiting

      // Local consts alongside the top-level `let`s so TypeScript's
      // narrowing survives the `await` boundaries that follow — the
      // fields could theoretically be reassigned by an interleaving
      // effect, which is why TS (and WebStorm's stricter analyzer)
      // refuse to assume they stay non-null after an await. Locals
      // can't be reassigned, so call sites stay type-safe without
      // `!` assertions. Same dance as NoteEditor.svelte.
      const localYDoc = new Y.Doc();
      yDoc = localYDoc;
      if (note.yrs_state.length > 0) {
        try {
          Y.applyUpdate(localYDoc, new Uint8Array(note.yrs_state));
        } catch (err) {
          console.warn('[FreeformNoteEditor] yrs_state hydration failed', err);
        }
      }

      const localAwareness = new Awareness(localYDoc);
      awareness = localAwareness;
      try {
        const session = await etebaseSession();
        const userName = session?.username ?? 'You';
        localAwareness.setLocalStateField('user', { name: userName });
      } catch (err) {
        console.debug('[FreeformNoteEditor] no session for awareness', err);
      }

      // Dynamically import React + tldraw + the island. Three separate
      // chunks fall out of this: react-dom/client, the island module
      // (which statically imports tldraw + the bridge), and react itself
      // is pulled in transitively by the island. The markdown editor's
      // bundle stays untouched — drawing notes pay this cost only when
      // opened.
      //
      // We deliberately don't use `Promise.all([...])` here: the IDE's
      // TypeScript inference (and svelte-check in some configs) widens
      // heterogeneous import() tuples into a union-of-modules array,
      // which makes `[a, b, c]` destructuring lose its per-element
      // types. Issuing the imports as bare expressions starts all three
      // in parallel; awaiting each ref preserves the specific module
      // type for narrowing.
      const reactDomPromise = import('react-dom/client');
      const islandPromise = import('$lib/freeform/TldrawIsland');
      const reactPromise = import('react');
      const { createRoot } = await reactDomPromise;
      const islandModule = await islandPromise;
      const reactModule = await reactPromise;
      if (!mountEl) return;
      TldrawIslandComponent = islandModule.default;
      reactCreateElement = reactModule.createElement;
      reactRoot = createRoot(mountEl);
      // First render: pass yDoc + awareness + current readonly + the
      // current colour-scheme preference. Re-render happens reactively
      // via the $effect below whenever isTrashed or the app theme flips.
      // Both reads use untrack() because this initial render runs inside
      // onMount, not inside a tracking scope — the $effect below is
      // what wires the reactivity for subsequent updates.
      reactRoot.render(
        reactCreateElement(TldrawIslandComponent, {
          yDoc,
          awareness,
          readOnly: untrack(() => isTrashed),
          noteId,
          colorScheme: untrack(() => $userPrefersMode) ?? 'system',
          penMode: untrack(() => penMode)
        })
      );

      // Same save trigger as NoteEditor: yDoc 'update' fires for every
      // mutation (local + remote-applied), giving us one hook to debounce
      // against. The bridge translates tldraw store ops into Yjs ops
      // before this fires, so we capture both editor-driven and
      // collab-driven changes through the same path.
      yDocUpdateHandler = () => {
        if (!saveReady) return;
        scheduleSave();
      };
      localYDoc.on('update', yDocUpdateHandler);
      saveReady = true;

      lastSeenPushed = tree.notesById[noteId]?.pushed ?? false;
      await setupCollabProvider();
      collabReady = true;

      unsubSession = onSessionChange(() => {
        void setupCollabProvider();
      });

      // Merge fresh yrs_state into the live Y.Doc whenever sync pulls
      // this note. Same Yjs CRDT-merge story as NoteEditor — local
      // edits stay, pulled state converges, re-applying an already-
      // known update is a no-op. The tldraw store auto-reflects the
      // resulting Y.Doc changes via the bridge in tldraw-yjs.
      void listen('sync-completed', async (payload) => {
        if (!payload.notes_pulled_ids.includes(noteId) || !yDoc) return;
        try {
          const fresh = await loadNote(noteId);
          if (yDoc && fresh.yrs_state.length > 0) {
            Y.applyUpdate(yDoc, new Uint8Array(fresh.yrs_state));
          }
        } catch (err) {
          console.warn('[FreeformNoteEditor] sync-completed merge failed', err);
        }
      }).then((unlisten) => {
        unsubSync = unlisten;
      });

      loading = false;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      loading = false;
      console.error('[FreeformNoteEditor] load failed', err);
    }
  });

  // Re-render the island whenever any prop tldraw cares about flips —
  // currently trashed state (toggles the canvas to read-only mid-session)
  // and the app-wide colour scheme (mode-watcher → tldraw user
  // preferences). The island maps each prop into the matching tldraw API
  // inside its own useEffect; React reconciliation between renders keeps
  // tldraw's internal state intact.
  $effect(() => {
    const readOnly = isTrashed;
    const colorScheme = $userPrefersMode ?? 'system';
    const currentPenMode = penMode;
    if (!reactRoot || !TldrawIslandComponent || !reactCreateElement) return;
    if (!yDoc || !awareness) return;
    reactRoot.render(
      reactCreateElement(TldrawIslandComponent, {
        yDoc,
        awareness,
        readOnly,
        noteId,
        colorScheme,
        penMode: currentPenMode
      })
    );
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
    unsubSync?.();
    unsubSync = null;
    unsubSession = null;
    // Drop our row from the global status store so the dockview
    // header doesn't keep showing stale icons after the panel closes.
    clearNoteStatus(noteId);
    saveReady = false;

    // React first — its cleanup runs synchronously and lets the bridge
    // tear down its store listeners before we kill the Y.Doc out from
    // under it.
    if (reactRoot) {
      try {
        reactRoot.unmount();
      } catch (err) {
        console.debug('[FreeformNoteEditor] react root unmount failed', err);
      }
      reactRoot = null;
    }
    TldrawIslandComponent = null;
    reactCreateElement = null;

    if (yDoc && yDocUpdateHandler) yDoc.off('update', yDocUpdateHandler);
    yDocUpdateHandler = null;
    provider?.destroy();
    provider = null;
    collabOnline = false;
    collabConfigured = false;
    awareness?.destroy();
    awareness = null;
    yDoc?.destroy();
    yDoc = null;
  });

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
        // body stays empty for freeform notes — there's no markdown
        // snapshot to render server-side. Future: OCR text could land
        // here for full-text search.
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

  // Mirror our reactive status into the global per-note store so the
  // dockview right-header (NoteStatusIcons.svelte) renders the icons
  // next to the popout button. Same plumbing NoteEditor uses; the
  // store is note_kind-agnostic.
  $effect(() => {
    setNoteStatus(noteId, {
      collabConfigured,
      collabOnline,
      savingState,
      isTrashed
    });
  });
</script>

<div class="flex h-full w-full flex-col">
  {#if mobile && !isTrashed}
    <!-- Mobile keeps the inline indicator since there's no dockview
         tab header to host the icon chips. Desktop pushes the same
         state into the note-status store and the right-header renders
         it next to the popout button. -->
    <div
      class="flex h-5 shrink-0 items-center justify-end gap-2 px-3 text-[10px] uppercase tracking-wider text-muted-foreground"
      aria-live="polite"
    >
      {#if collabConfigured}
        {#if collabOnline}
          <span class="flex items-center gap-1" title="Live collab connected">
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
  <!--
    Tldraw's root sizes itself via `position: absolute; inset: 0`. The
    mount div needs `position: relative` to be that absolute's containing
    block, and `flex-1 min-h-0` so it actually claims the remaining
    column height inside the surrounding flex layout (h-full alone would
    overflow the parent if the status row is rendered).
  -->
  <div class="relative min-h-0 w-full flex-1">
    {#if loading}
      <p class="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
        Loading drawing…
      </p>
    {:else if loadError}
      <p class="absolute inset-0 flex items-center justify-center px-2 text-sm text-destructive">
        Couldn't load drawing: {loadError}
      </p>
    {/if}
    <div bind:this={mountEl} class="absolute inset-0"></div>
  </div>
</div>
