<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Crepe } from '@milkdown/crepe';
  import { editorViewCtx, serializerCtx } from '@milkdown/kit/core';
  import { collabServiceCtx } from '@milkdown/plugin-collab';
  import * as Y from 'yjs';
  import { Awareness } from 'y-protocols/awareness';
  import {
    loadNote,
    saveNote as apiSaveNote,
    TRASH_ID,
    noteRoomInfo,
    etebaseSession,
    getYjsRelayUrl,
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
  import { buildCrepe } from '$lib/editor/crepe-setup';
  import { ensureDropIndicatorAlignment } from '$lib/editor/drop-indicator-align';
  import { pickCursorColor } from '$lib/editor/cursor-color';
  import { base64ToBytes } from '$lib/editor/base64';
  import { createWikilinkBridge } from '$lib/editor/plugins';
  import {
    registerEditor,
    unregisterEditor,
    MARKDOWN_ACTIONS,
    type EditorListener
  } from '$lib/hotkeys';
  import EditorToolbar from './editor-toolbar/EditorToolbar.svelte';
  import MobileEditorToolbar from './editor-toolbar/MobileEditorToolbar.svelte';
  import TrashBanner from './note-editor/TrashBanner.svelte';
  import WikilinkMenu from './note-editor/WikilinkMenu.svelte';

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
  const mermaidEnabled = $derived(
    (getSettingValue('editor.mermaid') as boolean | undefined) ?? true
  );
  const wikilinksEnabled = $derived(
    (getSettingValue('editor.wikilinks') as boolean | undefined) ?? true
  );

  // Per-editor bridge between the wikilink trigger plugin and the
  // WikilinkMenu popup. Created up-front (cheap; just a $state object)
  // so the popup template never has to defend against `bridge == null`
  // — if wikilinks are off, the plugin simply never opens it.
  const wikilinkBridge = createWikilinkBridge();

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
  // open note, disposed in onDestroy so blob URLs don't leak.
  let assetBridge: AssetBridge | null = null;
  let collabOnline = $state(false);
  let collabConfigured = $state(false);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let loading = $state(true);
  let savingState = $state<'idle' | 'pending' | 'saving' | 'saved' | 'error'>(
    'idle'
  );
  let loadError = $state<string | null>(null);

  /**
   * Command-bus listener for this note.
   *
   * `$state` so the `focusin` $effect below picks up the transition
   * from `null` → the registered listener (a plain `let` wouldn't
   * trigger Svelte's reactivity — the effect would run once with
   * `null`, early-return, and never re-attach). That matters when
   * two notes are open in dockview: without it, clicking the
   * non-top note wouldn't re-promote it on the bus stack and
   * editor hotkeys would route to the wrong document.
   *
   * The listener is the editor's ONLY contact with the hotkey module:
   * it receives command ids and runs the matching action. It knows
   * nothing about keyboard shortcuts, binding strings, or settings.
   */
  let editorListener: EditorListener | null = $state(null);

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
          hydratedFragment = localYDoc.getXmlFragment('prosemirror').length > 0;
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
          color: pickCursorColor(userName)
        });
      } catch (err) {
        console.debug('[NoteEditor] no session for awareness', err);
      }

      // Bridge is per-note so uploads carry the right owning_note_id
      // (FK + sync routing) and the blob-URL cache disposes cleanly on
      // editor unmount. Everything else about Crepe construction (feature
      // flags, plugin stack, image hooks) lives in $lib/editor/crepe-setup.
      assetBridge = createAssetBridge(noteId);
      crepe = buildCrepe({
        host,
        mobile,
        mathEnabled,
        autoPairEnabled,
        mermaidEnabled,
        wikilinksEnabled,
        wikilinkBridge,
        assetBridge
      });
      await crepe.create();

      // Keep the block-drag drop indicator aligned with the cursor. The
      // indicator is `position: fixed` but lives inside Dockview's
      // transformed panel, so it'd otherwise render offset by the chrome.
      // See drop-indicator-align.ts. Idempotent + global; the block handle
      // (and thus the indicator) only exists on desktop, where BlockEdit is on.
      if (!mobile) ensureDropIndicatorAlignment();

      // Register with the command bus as soon as Crepe is interactive.
      //
      // Do this BEFORE the subsequent awaits (`setupCollabProvider`'s
      // Tauri `noteRoomInfo` IPC in particular can take hundreds of ms
      // during cold app startup, when dockview is restoring a session's
      // worth of panels). The editor is fully typable the moment
      // `crepe.create()` resolves; if we wait until the end of onMount
      // to register, anything the user types in that window — including
      // hotkey-shaped events like AltGr+0 (`Ctrl+Alt+0` on German
      // Windows) — bypasses the manager and goes straight into the
      // contenteditable as a `}`. Reopening the note happened to win the
      // race because by then the IPC layer is warm.
      //
      // `onCommand` closes over the *current* `crepe`; reassignment in
      // onDestroy can't strand a stale reference. The bus's
      // `host.contains(target)` check uses this host element to exempt
      // the contenteditable from the blocked-input rule.
      if (host && crepe) {
        const activeCrepe = crepe;
        editorListener = {
          kind: 'markdown',
          host,
          onCommand: (id: string) => {
            const action = MARKDOWN_ACTIONS[id];
            // The bus already gated on `editorKind === 'markdown'`,
            // so an id missing from the table means catalogue drift
            // (a hotkey command registered without a matching
            // markdown action). Return `false` so the bus knows
            // nothing was handled and the keystroke falls through.
            if (!action) {
              console.warn('[NoteEditor] unknown markdown command', id);
              return false;
            }
            try {
              activeCrepe.editor.action(action);
              return true;
            } catch (err) {
              console.error('[NoteEditor] command threw', id, err);
              return false;
            }
          }
        };
        registerEditor(editorListener);
      }

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
        handleSyncCompleted(
          payload.notes_pulled_ids,
          payload.assets_pulled_ids
        );
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

  /**
   * Re-promote this editor to the top of the command bus stack when
   * the user clicks back into it. Without this, two notes open in
   * dockview would always route commands to whichever was registered
   * LAST — even after the user clicked the other one. focusin bubbles,
   * so we can watch the editor host and catch any contenteditable /
   * toolbar focus.
   *
   * No focusout handler: focusout fires on every toolbar click and
   * would pop the editor mid-action. The stack ordering alone is
   * enough — the editor stays "active" until another editor focuses
   * in or it unmounts.
   */
  $effect(() => {
    if (!host || !editorListener) return;
    const listener = editorListener;
    const onFocusIn = () => {
      // registerEditor is the "re-promote" path too: if the listener
      // is already registered it gets moved to the top of the stack.
      registerEditor(listener);
    };
    host.addEventListener('focusin', onFocusIn);
    return () => host?.removeEventListener('focusin', onFocusIn);
  });

  onDestroy(() => {
    if (saveTimer) clearTimeout(saveTimer);
    if (editorListener) {
      unregisterEditor(editorListener);
      editorListener = null;
    }
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
  {#if isTrashed}
    <TrashBanner />
  {/if}
  <!--
    flex-1 + min-h-0 (not h-full) so the scroll area fills the *remaining*
    height after the desktop toolbar and trash banner take theirs.
    h-full was strict-100%-of-parent and could overflow the parent chrome,
    especially on mobile where focused content can tempt the webview to
    scroll the document body to "fix" it.
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

<!--
  Wikilink popup: portal'd out of the editor's overflow container via
  position:fixed (see WikilinkMenu's `style` derivation). Rendered
  here at the root of the component template so it isn't clipped by
  the scroll wrapper.  Closed and gated by `bridge.state.open`, which
  the plugin only flips when wikilinks are enabled, so leaving this
  in the tree unconditionally costs ~0 when the setting is off.
-->
<WikilinkMenu bridge={wikilinkBridge} />
