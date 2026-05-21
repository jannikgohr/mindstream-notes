<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Crepe, CrepeFeature } from '@milkdown/crepe';
  import { editorViewCtx, serializerCtx } from '@milkdown/kit/core';
  import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
  // Imported via the kit subpath rather than `@milkdown/plugin-listener`
  // directly — keeps us from declaring a transitive dep that's already
  // bundled through @milkdown/kit.
  import { listener } from '@milkdown/kit/plugin/listener';
  import { autoPair } from '$lib/editor/auto-pair';
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
  import {
    setNoteStatus,
    clearNoteStatus
  } from '$lib/stores/note-status.svelte';
  import { getSettingValue, settings } from '$lib/settings/store.svelte';
  import { CollabProvider } from '$lib/sync/collab-provider';
  import { isMobile } from '$lib/platform';
  import {
    createAssetBridge,
    ASSET_SCHEME,
    type AssetBridge
  } from '$lib/assets/bridge';
  import { listen } from '$lib/api/events';
  import EditorToolbar from './editor-toolbar/EditorToolbar.svelte';
  import MobileEditorToolbar from './editor-toolbar/MobileEditorToolbar.svelte';

  interface Props {
    noteId: string;
  }
  let { noteId }: Props = $props();

  /**
   * Auto-save settings — both reactive so a live change in the settings
   * dialog takes effect on the next keystroke without remounting the
   * editor. The debounce read is bounded defensively because a corrupt
   * localStorage entry could otherwise put the editor into an infinite-
   * scheduled state (0 or negative) or fire too rarely to be useful.
   */
  const autoSaveEnabled = $derived(
    (getSettingValue('editor.autoSave') as boolean | undefined) ?? true
  );
  const saveDebounceMs = $derived.by(() => {
    const raw = getSettingValue('editor.autoSaveDebounce');
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return 800;
    return Math.min(5000, Math.max(100, n));
  });
  const trimTrailingOnSave = $derived(
    (getSettingValue('editor.trimTrailing') as boolean | undefined) ?? true
  );
  const mathEnabled = $derived(
    (getSettingValue('editor.math') as boolean | undefined) ?? true
  );
  const autoPairEnabled = $derived(
    (getSettingValue('editor.autoPair') as boolean | undefined) ?? true
  );

  let host: HTMLDivElement | null = $state(null);
  // $state because we hand the instance to MobileEditorToolbar as a prop;
  // a plain `let` would make the child see a stale `null` after mount.
  let crepe: Crepe | null = $state(null);
  let crepeReady = $state(false);
  // Drives both the Crepe feature config (drop the block-handle + slash
  // menu) and a wrapper class app.css uses to zero out the editor's
  // horizontal padding on small screens. Resolved in onMount because
  // isMobile() reads navigator.userAgent — unavailable during SSR.
  let mobile = $state(false);
  let yDoc: Y.Doc | null = null;
  let awareness: Awareness | null = null;
  let provider: CollabProvider | null = null;
  // Asset bridge for image upload + render-time URL resolution. One per
  // open note, disposed in onDestroy so blob URLs don't leak. Same
  // bridge backs the freeform editor's tldraw assetStore — see
  // $lib/assets/bridge.
  let assetBridge: AssetBridge | null = null;
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
      //
      // We use a local `const` alongside assigning the top-level `let`
      // so TypeScript's narrowing survives the `await` boundaries
      // below — the top-level field could theoretically be reassigned
      // by an interleaving effect, which is why TS (and WebStorm's
      // strict analyzer) refuse to assume it stays non-null after an
      // await. The local can't be reassigned, so call sites stay
      // type-safe without `!` assertions.
      const localYDoc = new Y.Doc();
      yDoc = localYDoc;
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
          Y.applyUpdate(localYDoc, new Uint8Array(note.yrs_state));
          hydratedFragment =
            localYDoc.getXmlFragment('prosemirror').length > 0;
        } catch (err) {
          console.warn('[NoteEditor] yrs_state hydration failed', err);
        }
      }

      // Same narrowing trick as `localYDoc` above.
      const localAwareness = new Awareness(localYDoc);
      awareness = localAwareness;
      try {
        const session = await etebaseSession();
        const userName = session?.username ?? 'You';
        localAwareness.setLocalStateField('user', {
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
      // Asset hooks let Crepe's ImageBlock feature persist dropped /
      // pasted images via our encrypted SQLite assets table (sliced
      // 2a/b — same plumbing tldraw uses on the freeform side) instead
      // of stashing a session-lived `blob:` URL in the markdown. The
      // returned `asset:mindstream/<id>` URL is what lands in the
      // saved markdown body; `proxyDomURL` rehydrates it back into a
      // blob URL for every render so the editor can paint the image.
      // Bridge is per-note so uploads carry the right owning_note_id
      // (FK + sync routing) and the blob-URL cache disposes cleanly
      // on editor unmount.
      assetBridge = createAssetBridge(noteId);
      const imageBlockConfig = {
        onUpload: assetBridge.uploadFile,
        // Crepe exposes separate hooks for inline vs block image — both
        // route through the same upload path so the asset:url ends up
        // in the markdown either way.
        inlineOnUpload: assetBridge.uploadFile,
        blockOnUpload: assetBridge.uploadFile,
        proxyDomURL: assetBridge.resolveUrl
      };
      // Feature toggles read from settings at construct time only — Crepe
      // doesn't expose a way to flip features after .create() short of
      // rebuilding the editor, and a rebuild mid-session would discard the
      // live collab state and any unsaved drag in flight. So changes to
      // `editor.math` apply on the next note open.
      const features: Partial<Record<CrepeFeature, boolean>> = {};
      if (mobile) features[Crepe.Feature.BlockEdit] = false;
      if (!mathEnabled) features[Crepe.Feature.Latex] = false;
      crepe = new Crepe({
        root: host,
        defaultValue: '',
        features: Object.keys(features).length > 0 ? features : undefined,
        featureConfigs: {
          [Crepe.Feature.ImageBlock]: imageBlockConfig
        }
      });
      crepe.editor.use(collab);
      // The listener plugin gives EditorToolbar a single hook to refresh
      // its mark-active state (Bold/Italic icons) on every transaction —
      // selectionUpdated and updated cover cursor moves, typing, remote
      // collab edits, etc. Without it the toolbar would have to install
      // its own prose plugin, which Crepe doesn't allow post-create.
      crepe.editor.use(listener);
      // Auto-pair brackets: same construct-time gating as the math/feature
      // toggles — toggling it in settings applies to notes opened after
      // the change. Skipped entirely (not just no-op'd) when off so we
      // don't run the handleTextInput hook on every keystroke.
      if (autoPairEnabled) crepe.editor.use(autoPair);
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
      localYDoc.on('update', yDocUpdateHandler);
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

      // React to background sync completing. Two jobs:
      //   1. If this note's yrs_state was updated upstream, merge the
      //      latest disk state into our live Y.Doc. Y.applyUpdate is a
      //      CRDT-safe merge — local in-flight edits remain, the
      //      pulled bytes converge with them. Idempotent if the relay
      //      already delivered the same update.
      //   2. If any image in the doc resolves to a freshly-pulled
      //      asset, evict its blob URL from the bridge cache and
      //      dispatch a no-op `setNodeMarkup` on the matching image
      //      nodes so the Crepe NodeView re-fires `proxyDomURL` and
      //      paints the now-present bytes.
      // Both are best-effort: if the editor is mid-teardown when the
      // event fires, the no-op'd refs short-circuit safely.
      void listen('sync-completed', (payload) => {
        handleSyncCompleted(payload.notes_pulled_ids, payload.assets_pulled_ids);
      }).then((unlisten) => {
        unsubSync = unlisten;
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
  /** Tauri `sync-completed` subscription. Unwrapped from a Promise<UnlistenFn>
   *  in onMount, called on destroy. Null until the listener resolves. */
  let unsubSync: (() => void) | null = null;

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

  /**
   * Refresh the open editor after a successful sync. Called from the
   * `sync-completed` Tauri event handler.
   *
   * Both halves are best-effort: each guard short-circuits if the
   * editor is mid-teardown or simply doesn't care about the change.
   *
   *   notes_pulled_ids: if our noteId is in here, re-read the note's
   *     yrs_state from SQLite and `Y.applyUpdate` it into the live
   *     Y.Doc. Yjs is a CRDT, so this MERGES — it never overwrites
   *     local in-flight edits. Re-applying an already-known update
   *     (e.g. the live relay also delivered it) is a no-op.
   *
   *   assets_pulled_ids: walk the doc for image nodes whose src
   *     references one of these assets, evict the bridge's blob URL
   *     cache for those URLs, then dispatch a no-op `setNodeMarkup`
   *     on each matching node. The transaction wakes the Crepe image
   *     NodeView's update, which re-invokes `proxyDomURL`, which now
   *     hits the freshly-pulled SQLite row and returns a working blob
   *     URL — the broken-image placeholder repaints as the image.
   */
  async function handleSyncCompleted(
    notesPulledIds: string[],
    assetsPulledIds: string[]
  ) {
    if (notesPulledIds.includes(noteId) && yDoc) {
      try {
        const fresh = await loadNote(noteId);
        if (yDoc && fresh.yrs_state.length > 0) {
          Y.applyUpdate(yDoc, new Uint8Array(fresh.yrs_state));
        }
      } catch (err) {
        console.warn('[NoteEditor] sync-completed note merge failed', err);
      }
    }

    if (assetsPulledIds.length === 0 || !assetBridge || !crepe) return;

    // Build the set of URLs we want to refresh from the pulled ids
    // directly — NOT from `invalidate`'s return value. The bridge
    // doesn't cache failed resolves (the live-collab-arrived-image
    // case where the asset wasn't yet in SQLite), so the cache could
    // be empty even though the doc still references those URLs. Then
    // evict from the bridge so the kicked NodeView's proxyDomURL
    // hits SQLite afresh instead of returning a stale entry.
    const targetUrls = new Set(
      assetsPulledIds.map((id) => `${ASSET_SCHEME}${id}`)
    );
    assetBridge.invalidate(assetsPulledIds);

    try {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state } = view;
        const tr = state.tr;
        let touched = false;
        state.doc.descendants((node, pos) => {
          // The Crepe image-block schema uses `image-block`; the inline
          // variant uses `image`. Both store the URL on the `src` attr.
          // Treat any node with a src attr in the target set as a hit
          // rather than enumerating known names — keeps us correct if
          // Crepe adds new image-shaped node types later.
          const src = node.attrs?.src;
          if (typeof src === 'string' && targetUrls.has(src)) {
            // No-op setNodeMarkup (same attrs) still produces a
            // transaction step that ProseMirror replays through the
            // NodeView's update(), which re-runs proxyDomURL. Bumping
            // a sentinel attr would be cleaner but the schema doesn't
            // declare one and adding it would invalidate existing
            // markdown round-trips.
            tr.setNodeMarkup(pos, undefined, { ...node.attrs });
            touched = true;
          }
        });
        if (touched) {
          // setMeta + addToHistory(false) so the kick doesn't pollute
          // undo history and the live-collab plugin doesn't echo a
          // semantically-empty change to peers.
          tr.setMeta('addToHistory', false);
          view.dispatch(tr);
        }
      });
    } catch (err) {
      console.warn('[NoteEditor] sync-completed asset kick failed', err);
    }
  }

  onDestroy(() => {
    if (saveTimer) clearTimeout(saveTimer);
    unsubSession?.();
    unsubSession = null;
    unsubSync?.();
    unsubSync = null;
    // Drop our row from the global status store so the dockview
    // header doesn't keep showing stale icons after the panel closes.
    clearNoteStatus(noteId);
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
    // Crepe destroy synchronously rips down ProseMirror; image views
    // are gone by now, so revoking the blob URLs here is safe (and
    // necessary — they'd otherwise leak for the editor's lifetime).
    assetBridge?.dispose();
    assetBridge = null;
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
    // Honour the user's auto-save toggle. We still cancel any in-flight
    // debounce so a setting flip mid-debounce doesn't fire one last save
    // after the user turned it off. yrs_state continues to mutate locally
    // either way — the next manual save (or re-enabling auto-save with a
    // fresh keystroke) will flush.
    if (!autoSaveEnabled) {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      savingState = 'idle';
      return;
    }
    savingState = 'pending';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        savingState = 'saving';
        // Capture the markdown + y-doc state *now*, after the user has
        // stopped typing for saveDebounceMs. Pulling markdown via the
        // live serializer (instead of via the listener plugin) means
        // remote-applied edits — which y-prosemirror dispatches with
        // `addToHistory: false` and which the listener therefore ignores
        // — are still reflected in the body we save. Array.from is
        // necessary because Tauri serialises Uint8Array as an empty
        // object via JSON.stringify.
        const rawMarkdown = getMarkdown ? getMarkdown() : '';
        // Trim trailing whitespace per-line on the way to disk. We don't
        // mutate the live editor doc — that would jump the caret and
        // broadcast a no-op edit to peers; we only sanitise the snapshot
        // we hand to Rust.
        const markdown = trimTrailingOnSave
          ? rawMarkdown.replace(/[ \t]+$/gm, '')
          : rawMarkdown;
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
    }, saveDebounceMs);
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

  // Desktop toolbar visibility is a per-device toggle (default on). The
  // settings.values read makes this $derived re-evaluate when the user flips
  // the toggle live. Trashed notes hide the toolbar too — it'd be misleading
  // to show formatting buttons over a read-only banner.
  const desktopToolbarEnabled = $derived(
    (settings.values['editor.desktopToolbar'] ?? true) as boolean
  );
  const showDesktopToolbar = $derived(
    !mobile && crepeReady && !isTrashed && desktopToolbarEnabled
  );
  const showMobileToolbar = $derived(mobile && crepeReady && !isTrashed);

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

  // Mirror our reactive status into the global per-note store so the
  // dockview right-header (NoteStatusIcons.svelte) can render the
  // icons next to the popout button. Re-runs whenever any of the
  // four fields changes; cleared in onDestroy so closing the panel
  // also removes the row.
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
  {#if showDesktopToolbar}
    <EditorToolbar
      {crepe}
      menuPlacement="bottom"
      dense
      class="border-b border-border bg-background"
    />
  {/if}
  {#if mobile && !isTrashed}
    <!-- Mobile keeps the inline Saved/Editing/Live indicator because
         there's no dockview tab header to host the icon equivalent.
         Desktop pushes the same state into the note-status store and
         the right-header chips render it next to the popout button.
         Hidden on trashed notes — the trash banner below already
         conveys read-only. -->
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
      <span>
        This note is in the trash and is read-only. Restore it to edit.
      </span>
    </div>
  {/if}
  <!--
    flex-1 + min-h-0 (not h-full) so the scroll area fills the *remaining*
    height after the desktop toolbar, status row, and trash banner take
    theirs. h-full was strict-100%-of-parent and overflowed by exactly
    the status row's height (20px) on every non-trashed note — invisible
    on desktop (clipped by panel chrome) but on mobile could push the
    focused caret into the hidden zone and tempt the webview to scroll
    the document body to "fix" it.
  -->
  <div class="themed-scrollbar relative min-h-0 w-full flex-1 overflow-y-auto">
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

{#if showMobileToolbar}
  <MobileEditorToolbar {crepe} />
{/if}
