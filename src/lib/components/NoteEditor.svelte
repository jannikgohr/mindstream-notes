<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Crepe } from '@milkdown/crepe';
  import { editorViewCtx, serializerCtx } from '@milkdown/kit/core';
  import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
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
  import { isMobile } from '$lib/platform';

  interface Props {
    noteId: string;
  }
  let { noteId }: Props = $props();

  /**
   * Debounce the auto-save: wait this long after the last keystroke before
   * hitting Rust. The user said "save after inactivity" — 800ms feels
   * unhurried but doesn't risk losing typing in a crash.
   */
  const SAVE_DEBOUNCE_MS = 800;

  let host: HTMLDivElement | null = $state(null);
  let crepe: Crepe | null = null;
  let crepeReady = $state(false);
  // Drives both the Crepe feature config (drop the block-handle + slash
  // menu) and a wrapper class app.css uses to zero out the editor's
  // horizontal padding on small screens. Resolved in onMount because
  // isMobile() reads navigator.userAgent — unavailable during SSR.
  let mobile = $state(false);
  let yDoc: Y.Doc | null = null;
  let awareness: Awareness | null = null;
  let provider: CollabProvider | null = null;
  let collabOnline = $state(false);
  let collabConfigured = $state(false);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let loading = $state(true);
  let savingState = $state<'idle' | 'pending' | 'saving' | 'saved' | 'error'>(
    'idle'
  );
  let loadError = $state<string | null>(null);

  // Captured inside the editor's `action` callback so handleChange can
  // read the live markdown without going through the listener plugin —
  // see the long comment around the yDoc 'update' hook below.
  let getMarkdown: (() => string) | null = null;
  let yDocUpdateHandler: (() => void) | null = null;
  // Gate yDoc 'update' events from triggering saves until we've finished
  // hydrating the doc + binding the editor. Otherwise the initial template
  // population would schedule a phantom save 800ms after open.
  let saveReady = false;

  /**
   * Walks the note's ancestor folder chain to see if any of them is the
   * special trash collection. Direct-parent equality isn't enough — when
   * the user trashes a folder via "move to trash", the folder's notes
   * keep their original parent_collection_id (see the Rust test
   * `moving_a_collection_does_not_delete_its_notes`), so a note buried
   * three folders deep inside a trashed folder still needs to lock.
   * Cycle guard is defensive — the backend rejects parent cycles, but
   * a corrupt local cache shouldn't hang the editor.
   */
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

  // "Trashed" has four shapes the editor needs to recognise:
  //   1. data.useTrash = true (default) — the note is moved into the
  //      special 'trash' collection, but trashed_at stays NULL.
  //   2. The note's *containing folder* (or any ancestor folder) is in
  //      trash. The note's own parent_collection_id doesn't change in
  //      this case — only an ancestor walk catches it.
  //   3. data.useTrash = false — trashed_at is set AND trashNote() in
  //      tree.svelte.ts removes the row from notesById, so the entry
  //      is just gone from the local tree.
  //   4. The note has been purged remotely while the tab is still open —
  //      same "missing from tree" signature as (3). We treat it as
  //      trashed read-only too, which is safer than letting the user
  //      keep typing into a save that'll fail.
  // Gated on tree.ready so we don't flash the banner during the brief
  // window between editor mount and the initial tree hydration.
  const isTrashed = $derived.by(() => {
    if (!tree.ready) return false;
    const n = tree.notesById[noteId];
    if (!n) return true;
    if (n.trashed === true) return true;
    return ancestorIsTrash(n.parent_collection_id);
  });

  onMount(async () => {
    if (!host) return;
    try {
      mobile = isMobile();
      const note = await loadNote(noteId);
      if (!host) return; // unmounted while awaiting

      // Build the live Doc + Awareness BEFORE we ask Crepe to materialise
      // the editor — the collab plugin needs them at bind time.
      yDoc = new Y.Doc();
      // Hydrate from disk only if the row is already in the v2
      // (y-prosemirror) format. Legacy v1 yrs_state is a Y.Text shape
      // that y-prosemirror can't decode; for those notes we leave the
      // Doc empty and the collab service's applyTemplate populates it
      // from `note.body` instead — that's the lazy migration path.
      //
      // We also track whether the hydration left us with a real prosemirror
      // fragment. The default applyTemplate condition is
      // `yDocNode.textContent.length === 0`, which is true for image-only
      // paragraphs, empty headings, etc. — letting it run on a populated
      // fragment with no plain text would `fragment.delete(0, length)` and
      // wipe the doc, broadcasting the wipe to peers via collab. So we
      // only fall back to applyTemplate when the fragment is truly empty.
      let hydratedFragment = false;
      if (note.payload_schema === 2 && note.yrs_state.length > 0) {
        try {
          Y.applyUpdate(yDoc, new Uint8Array(note.yrs_state));
          hydratedFragment =
            yDoc.getXmlFragment('prosemirror').length > 0;
        } catch (err) {
          console.warn('[NoteEditor] yrs_state hydration failed', err);
        }
      }

      awareness = new Awareness(yDoc);
      try {
        const session = await etebaseSession();
        const userName = session?.username ?? 'You';
        awareness.setLocalStateField('user', {
          name: userName,
          color: pickColor(userName)
        });
      } catch (err) {
        console.debug('[NoteEditor] no session for awareness', err);
      }

      // On mobile we disable Crepe's BlockEdit feature, which is the
      // single flag that bundles both `@milkdown/kit/plugin/block` (the
      // drag handle + "+" button that floats next to the active block)
      // and `@milkdown/kit/plugin/slash` (the typed "/" menu). The
      // block-handle is a hover/mouse affordance that doesn't make sense
      // on touch, and the slash menu is awkward on a mobile keyboard.
      // The 90px ProseMirror side-padding that exists to leave room for
      // the handle is also zeroed via the .mobile-editor class below.
      crepe = new Crepe({
        root: host,
        defaultValue: '',
        features: mobile ? { [Crepe.Feature.BlockEdit]: false } : undefined
      });
      crepe.editor.use(collab);
      await crepe.create();

      // Bind y-doc + awareness AFTER create, then snapshot the serializer
      // + view so we can render markdown on demand from any save trigger.
      crepe.editor.action((ctx) => {
        const cs = ctx.get(collabServiceCtx);
        cs.bindDoc(yDoc!);
        if (awareness) cs.setAwareness(awareness);
        if (!hydratedFragment) {
          // Empty doc → seed the fragment from the markdown body.
          cs.applyTemplate(note.body);
        }
        cs.connect();

        const serializer = ctx.get(serializerCtx);
        const view = ctx.get(editorViewCtx);
        getMarkdown = () => serializer(view.state.doc);
      });

      // Hook yDoc updates AFTER bind/applyTemplate/connect so the initial
      // fragment population doesn't trip a phantom save. From here on, every
      // doc mutation — whether a local keystroke (via y-prosemirror's
      // ySyncPlugin) or a remote edit applied by the CollabProvider —
      // schedules a debounced save. We don't go through the listener
      // plugin's `markdownUpdated` because it filters out transactions with
      // `addToHistory === false`, which is exactly what y-prosemirror sets
      // on remote-applied syncs — i.e. peer edits would update the visible
      // editor but never reach SQLite until the local user typed.
      yDocUpdateHandler = () => {
        if (!saveReady) return;
        scheduleSave();
      };
      yDoc.on('update', yDocUpdateHandler);
      saveReady = true;

      // Live collab is opt-in: a relay URL must be configured AND the
      // user has to have a live etebase session AND the note has to
      // have been pushed at least once (so it has a UID + key). Created
      // AFTER the editor is fully bound so the provider's doc-update
      // handler doesn't race with applyTemplate and doesn't attempt to
      // broadcast the initial fragment seed.
      lastSeenPushed = tree.notesById[noteId]?.pushed ?? false;
      await setupCollabProvider();
      // Now that the initial pushed-state is captured, let the $effect
      // react to *changes* (specifically false → true when the
      // post-create sync lands) without re-firing for the value we just
      // consumed.
      collabReady = true;

      // React to login/logout while this note is open. Logout returns
      // null from noteRoomInfo (the Rust side gates on has_session and
      // wipes the local key) so the re-init will quietly tear down;
      // login flips the gate back on and reconnects.
      unsubSession = onSessionChange(() => {
        void setupCollabProvider();
      });

      crepeReady = true;
      loading = false;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      loading = false;
      console.error('[NoteEditor] load failed', err);
    }
  });

  let unsubSession: (() => void) | null = null;

  // Track whether the note has been pushed across reactive updates so
  // we only kick off a collab re-init when that transitions (false →
  // true means the post-create sync just made the room reachable; true
  // → false means a wipe / re-create elsewhere). Without this guard the
  // $effect would fire on every loadTree (which replaces tree.notesById
  // wholesale) and we'd tear down + recreate the provider on every
  // save — noteRoomInfo is an etebase HTTP round-trip we don't want to
  // repeat for no reason.
  let lastSeenPushed = false;
  let collabReady = false;

  $effect(() => {
    const pushed = tree.notesById[noteId]?.pushed ?? false;
    if (!collabReady) return;
    if (pushed === lastSeenPushed) return;
    lastSeenPushed = pushed;
    void setupCollabProvider();
  });

  /**
   * (Re)create the live-collab provider for the current note. Tears down
   * any existing one first so logout + relogin doesn't leak a stale
   * socket. Returns silently when prerequisites aren't met — no relay
   * URL configured, no session, or the note hasn't been pushed yet.
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
      console.debug('[NoteEditor] collab provider init failed', err);
    }
  }

  onDestroy(() => {
    if (saveTimer) clearTimeout(saveTimer);
    unsubSession?.();
    unsubSession = null;
    saveReady = false;
    if (yDoc && yDocUpdateHandler) {
      yDoc.off('update', yDocUpdateHandler);
    }
    yDocUpdateHandler = null;
    getMarkdown = null;

    // Detach y-prosemirror's collab plugins (ySyncPlugin / yCursorPlugin)
    // *synchronously* before the provider's awareness teardown runs.
    // provider.destroy() calls awareness.setLocalState(null), which fires
    // an awareness 'update' event. If yCursorPlugin is still observing,
    // it dispatches a cursor-decoration tx via view.dispatch — but
    // crepe.destroy() is async, so by the time that tx applies the
    // milkdown internal-plugin pipeline has already torn down
    // editorStateCtx and we get "Context 'editorState' not found".
    // cs.disconnect() reconfigures the editor's plugin list immediately
    // (no async, no view.dispatch — just view.updateState), pulling
    // yCursorPlugin out cleanly.
    if (crepe) {
      try {
        crepe.editor.action((ctx) => {
          ctx.get(collabServiceCtx).disconnect();
        });
      } catch (err) {
        console.debug('[NoteEditor] collab disconnect failed', err);
      }
    }

    provider?.destroy();
    provider = null;
    collabOnline = false;
    collabConfigured = false;
    crepe?.destroy();
    crepe = null;
    awareness?.destroy();
    awareness = null;
    yDoc?.destroy();
    yDoc = null;
    crepeReady = false;
  });

  // Push the trashed state into Crepe whenever either side changes.
  // Re-runs when crepeReady flips (handles the initial-state case for a
  // note that was already trashed when the tab opened) and when isTrashed
  // changes (remote pull, or local restore from another window).
  $effect(() => {
    if (!crepeReady || !crepe) return;
    crepe.setReadonly(isTrashed);
  });

  function scheduleSave() {
    // setReadonly(true) already prevents user input, but yDoc 'update' can
    // still fire from programmatic mutations or remote edits arriving on
    // a note that just got trashed elsewhere. Drop those silently rather
    // than persisting an edit to a trashed note.
    if (isTrashed) return;
    savingState = 'pending';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        savingState = 'saving';
        // Capture the markdown + y-doc state *now*, after the user has
        // stopped typing for SAVE_DEBOUNCE_MS. Pulling markdown via the
        // live serializer (instead of via the listener plugin) means
        // remote-applied edits — which y-prosemirror dispatches with
        // `addToHistory: false` and which the listener therefore ignores
        // — are still reflected in the body we save. Array.from is
        // necessary because Tauri serialises Uint8Array as an empty
        // object via JSON.stringify.
        const markdown = getMarkdown ? getMarkdown() : '';
        const yrsState = yDoc
          ? Array.from(Y.encodeStateAsUpdate(yDoc))
          : undefined;
        await apiSaveNote({ id: noteId, body: markdown, yrs_state: yrsState });
        // Mirror the new modified timestamp in the local cache so the
        // metadata panel reflects the save without a tree refetch.
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
        console.error('[NoteEditor] save failed', err);
      }
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Stable colour from the username so the same user shows the same
   * cursor colour across sessions and devices. Not security-relevant;
   * just a tiny readability win.
   *
   * Must be hex (`#rrggbb`) — y-prosemirror's yCursorPlugin warns
   * "A user uses an unsupported color format" on `hsl(...)` and similar
   * CSS functions. We pick from a fixed palette so all peers agree on
   * the same hex value for the same username without doing colour math.
   */
  const CURSOR_COLORS = [
    '#ef4444', '#f97316', '#eab308', '#22c55e', '#10b981',
    '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6',
    '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#84cc16'
  ];
  function pickColor(seed: string): string {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = (hash * 31 + seed.charCodeAt(i)) | 0;
    }
    return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
  }

  /**
   * Decode standard or URL-safe base64 into bytes. The Rust side emits
   * standard base64 via etebase::utils::to_base64; URL-safe handling is
   * defensive in case we ever swap encoders.
   */
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
      case 'pending':
        return 'Editing…';
      case 'saving':
        return 'Saving…';
      case 'saved':
        return 'Saved';
      case 'error':
        return 'Save failed';
      default:
        return '';
    }
  });
</script>

<div class="flex h-full w-full flex-col">
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
  {#if isTrashed}
    <div
      class="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive"
      role="status"
    >
      <Trash2 class="size-3.5 shrink-0" aria-hidden="true" />
      <span>
        This note is in the trash and is read-only. Restore it to edit.
      </span>
    </div>
  {/if}
  <div class="themed-scrollbar relative h-full w-full overflow-y-auto">
    {#if loading}
      <p class="px-6 py-4 text-sm text-muted-foreground">Loading note…</p>
    {:else if loadError}
      <p class="px-6 py-4 text-sm text-destructive">
        Couldn't load note: {loadError}
      </p>
    {/if}
    <div
      bind:this={host}
      class="mx-auto max-w-3xl"
      class:mobile-editor={mobile}
    ></div>
  </div>
</div>
