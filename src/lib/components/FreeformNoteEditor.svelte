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

  /** Debounce window for save scheduling — same as NoteEditor. */
  const SAVE_DEBOUNCE_MS = 800;

  /** Mount point for the React island. dockview gives us the full panel;
   *  the island fills it via `position: absolute; inset: 0`. */
  let mountEl: HTMLDivElement | null = $state(null);

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

  // ---- Mount ----

  let lastSeenPushed = false;
  let collabReady = false;
  let unsubSession: (() => void) | null = null;

  onMount(async () => {
    if (!mountEl) return;
    try {
      const note = await loadNote(noteId);
      if (!mountEl) return; // unmounted while awaiting

      yDoc = new Y.Doc();
      if (note.yrs_state.length > 0) {
        try {
          Y.applyUpdate(yDoc, new Uint8Array(note.yrs_state));
        } catch (err) {
          console.warn('[FreeformNoteEditor] yrs_state hydration failed', err);
        }
      }

      awareness = new Awareness(yDoc);
      try {
        const session = await etebaseSession();
        const userName = session?.username ?? 'You';
        awareness.setLocalStateField('user', { name: userName });
      } catch (err) {
        console.debug('[FreeformNoteEditor] no session for awareness', err);
      }

      // Dynamically import React + tldraw + the island. Three separate
      // chunks fall out of this: react-dom/client, the island module
      // (which statically imports tldraw + the bridge), and react itself
      // is pulled in transitively by the island. The markdown editor's
      // bundle stays untouched — drawing notes pay this cost only when
      // opened.
      const [{ createRoot }, islandModule, reactModule] = await Promise.all([
        import('react-dom/client'),
        import('$lib/freeform/TldrawIsland'),
        import('react')
      ]);
      if (!mountEl) return;
      TldrawIslandComponent = islandModule.default;
      reactCreateElement = reactModule.createElement;
      reactRoot = createRoot(mountEl);
      // First render: pass yDoc + awareness + current readonly. Re-render
      // happens reactively via the $effect below whenever isTrashed flips.
      reactRoot.render(
        reactCreateElement(TldrawIslandComponent, {
          yDoc,
          awareness,
          readOnly: untrack(() => isTrashed)
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

  // Re-render the island when trashed flips so tldraw goes read-only
  // mid-session (e.g. another window trashes the note while this one is
  // open). The island itself derives `instanceState.isReadonly` from
  // this prop in its own useEffect.
  $effect(() => {
    const readOnly = isTrashed;
    if (!reactRoot || !TldrawIslandComponent || !reactCreateElement) return;
    if (!yDoc || !awareness) return;
    reactRoot.render(
      reactCreateElement(TldrawIslandComponent, { yDoc, awareness, readOnly })
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
    unsubSession = null;
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
