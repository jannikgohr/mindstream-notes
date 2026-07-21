<script lang="ts">
  /**
   * Freeform / drawing editor for `note_kind === 'freeform'` notes.
   *
   * Architecture: this Svelte component is just the shell — it owns the
   * local Y.Doc (for at-rest persistence), the ExcalidrawRoomClient
   * (live sync over the official excalidraw-room protocol), debounced
   * save, and trashed-state detection. The actual drawing surface is
   * Excalidraw, mounted as a React island inside this shell. React +
   * Excalidraw + the bridge are dynamically imported so they only pay
   * their bundle cost when a drawing note is opened.
   *
   * Doc shape: Excalidraw elements/files are still keyed by id in
   * Y.Maps via `$lib/freeform/excalidraw-yjs.ts` — the etebase
   * `yrs_state` field on each note round-trips that doc unchanged. The
   * Y.Doc is purely local persistence now; the wire goes through
   * excalidraw-room, not the yjs-relay, and the room sees only AES-GCM
   * ciphertext (per-note key HKDF-derived from the existing crypto_key,
   * see excalidraw-room-client.ts).
   *
   * Mobile: Excalidraw has touch handling built in (pan, pinch, draw). The
   * existing mobile formatting toolbar only mounts inside markdown notes,
   * so there's no conflict here.
   *
   * Deferred follow-ups (intentional):
   *   - Image insertion is disabled until Excalidraw files are backed by the
   *     shared asset table instead of inline data URLs.
   *   - Presence (remote cursors). excalidraw-room emits room-user-change
   *     and supports MOUSE_LOCATION; the client doesn't subscribe yet.
   */

  import { onDestroy, onMount, untrack } from 'svelte';
  import { createHistoryCapture } from '$lib/history/capture-scheduler';
  import * as Y from 'yjs';
  import { Trash2 } from '@lucide/svelte';
  import { userPrefersMode } from 'mode-watcher';
  import {
    getExcalidrawRoomUrl,
    loadNote,
    saveNote as apiSaveNote,
    TRASH_ID,
    noteRoomInfo,
    onSessionChange,
    captureCurrentNoteVersion,
    type VersionAction
  } from '$lib/api';
  import { tree } from '$lib/stores/tree.svelte';
  import {
    setNoteStatus,
    clearNoteStatus
  } from '$lib/stores/note-status.svelte';
  import { getSettingValue } from '$lib/settings/store.svelte';
  import { prefersReducedMotion } from '$lib/reduce-motion.svelte';
  import {
    ExcalidrawRoomClient,
    deriveExcalidrawKey
  } from '$lib/freeform/excalidraw-room-client';
  import { collabCredentialsChangedForNote } from '$lib/sync/collab-credentials';
  import {
    collabAuthForRoom,
    getOrCreateCollabSigningMaterial
  } from '$lib/sync/collab-signing-key';
  import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
  import { isMobile } from '$lib/platform';
  import { listen } from '$lib/api/events';
  import { acquireFullscreen, releaseFullscreen } from '$lib/window/fullscreen';
  import { isTauri } from '$lib/api';
  import {
    registerEditor,
    unregisterEditor,
    type EditorListener
  } from '$lib/hotkeys/bus.svelte';
  import {
    bumpNoteHistory,
    registerNoteHistory
  } from '$lib/stores/note-history-bridge.svelte';
  import {
    parseHistorySnapshot,
    serializeYjsSnapshot
  } from '$lib/history/snapshot';
  import {
    readSceneFromYDoc,
    replaceSceneInYDoc
  } from '$lib/freeform/excalidraw-yjs';

  interface Props {
    noteId: string;
  }
  let { noteId }: Props = $props();

  const historyCapture = createHistoryCapture({
    noteId: () => noteId,
    label: 'FreeformNoteEditor',
    isTrashed: () => isTrashed,
    isReady: () => yDoc !== null,
    mode: 'debounce',
    snapshotNowRequiresDirty: true
  });

  /** Debounce window for save scheduling — same as NoteEditor. */
  const SAVE_DEBOUNCE_MS = 800;

  /** Mount point for the React island. dockview gives us the full panel;
   *  the island fills it via `position: absolute; inset: 0`. */
  let mountEl: HTMLDivElement | null = $state(null);
  // isMobile() reads navigator.userAgent — unavailable during SSR, so
  // resolve in onMount. Same dance as NoteEditor.svelte.
  let mobile = $state(false);

  let yDoc: Y.Doc | null = null;
  let excalidrawApi: ExcalidrawImperativeAPI | null = null;

  let roomClient: ExcalidrawRoomClient | null = null;
  let collabOnline = $state(false);
  let collabConfigured = $state(false);

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  // Excalidraw bumps element version nonces when it re-imports a scene on
  // mount, which flushes a benign LOCAL_ORIGIN write to the Y.Doc. Without a
  // gate that churn marks the note dirty and snapshots a "no-edit" version on
  // the next close/remount. A real edit is always preceded by a pointer or key
  // interaction on the canvas, so only arm history capture once that happens.
  let canvasInteracted = false;
  let capturingHistorySnapshot = false;
  let unregisterHistory: (() => void) | null = null;
  let savingState = $state<'idle' | 'pending' | 'saving' | 'saved' | 'error'>(
    'idle'
  );
  let loading = $state(true);

  // Mobile auto-fullscreen tracking. `fullscreenAcquired` records
  // whether *this* component pushed the window into fullscreen so
  // onDestroy knows whether it needs to release the ref count. Desktop
  // has no fullscreen UI for freeform notes; the OS chrome stays.
  let fullscreenAcquired = false;
  let loadError = $state<string | null>(null);

  /**
   * Command-bus listener for this freeform canvas. There aren't any
   * freeform-scoped commands in the catalogue yet, so `onCommand`
   * just reports "didn't handle" for every id it receives — but
   * registering the listener still matters because it displaces any
   * markdown listener above it on the stack. A Mod+B fired here is
   * therefore routed to the freeform listener (which declines), the
   * bus reports the command as unhandled, and the manager lets the
   * keystroke fall through to Excalidraw rather than secretly editing a
   * markdown note the user can't see. Negative-space programming:
   * refuse the bug, don't paper it over.
   *
   * `$state` so the focusin $effect picks up the null → object
   * transition — same rationale as NoteEditor's listener.
   */
  let editorListener: EditorListener | null = $state(null);

  let yDocUpdateHandler: (() => void) | null = null;
  /** Gate yDoc updates from triggering saves until hydration is done. */
  let saveReady = false;

  // React island handles — typed as `unknown` because react-dom and the
  // island module are dynamic imports; the precise types aren't loaded
  // into the markdown / app-shell bundle.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let reactRoot: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ExcalidrawIslandComponent: any = null;
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

  /** Whether to cut editor animation cost. We honour the app-wide
   *  resolved reduce-motion preference AND default to true on
   *  mobile, where the Android WebView's compositor is the bottleneck
   *  during stroke rendering and incidental motion costs frame budget.
   *  `mobile` is set in onMount, so this reads false on initial render
   *  even on Android — that's fine, the [reduceMotion] effect re-runs
   *  once `mobile` flips. */
  const reduceMotion = $derived(prefersReducedMotion() || mobile);

  // ---- Mount ----

  let lastSeenPushed = false;
  let collabReady = false;
  let unsubSession: (() => void) | null = null;
  /** Tauri sync-completed subscription. Same idea as in NoteEditor:
   *  when sync pulls a fresh yrs_state for THIS note, we merge it into
   *  the open Y.Doc via Y.applyUpdate (Yjs CRDT-safe). Asset
   *  invalidation for Excalidraw scene files lives inside the React island. */
  let unsubSync: (() => void) | null = null;
  let unsubCollabCredentials: (() => void) | null = null;

  onMount(async () => {
    if (!mountEl) return;
    try {
      mobile = isMobile();
      // Mobile-only auto-fullscreen. Tauri-only because the API is a
      // no-op in a plain dev browser; we don't gate desktop here at all
      // since there's no UI for it. Fire-and-forget — the system-bar
      // hide isn't on the critical path for the first stroke.
      if (isTauri() && mobile) {
        void acquireFullscreen();
        fullscreenAcquired = true;
      }
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

      // Dynamically import React + Excalidraw + the island. Three separate
      // chunks fall out of this: react-dom/client, the island module
      // (which statically imports Excalidraw + the bridge), and react itself
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
      const islandPromise = import('$lib/freeform/ExcalidrawIsland');
      const reactPromise = import('react');
      const { createRoot } = await reactDomPromise;
      const islandModule = await islandPromise;
      const reactModule = await reactPromise;
      if (!mountEl) return;
      ExcalidrawIslandComponent = islandModule.default;
      reactCreateElement = reactModule.createElement;
      reactRoot = createRoot(mountEl);
      // First render: pass yDoc + current readonly + the
      // current colour-scheme preference. Re-render happens reactively
      // via the $effect below whenever isTrashed or the app theme flips.
      // Both reads use untrack() because this initial render runs inside
      // onMount, not inside a tracking scope — the $effect below is
      // what wires the reactivity for subsequent updates.
      reactRoot.render(
        reactCreateElement(ExcalidrawIslandComponent, {
          yDoc,
          readOnly: untrack(() => isTrashed),
          noteId,
          colorScheme: untrack(() => $userPrefersMode) ?? 'system',
          penMode: untrack(() => penMode),
          reduceMotion: untrack(() => reduceMotion),
          onApiReady: handleExcalidrawApi
        })
      );

      // Same save trigger as NoteEditor: yDoc 'update' fires for every
      // mutation (local + remote-applied via Y.applyUpdate after sync
      // pulls a fresh yrs_state), giving us one hook to debounce against.
      // The local-write bridge in excalidraw-yjs.ts translates Excalidraw
      // onChange callbacks into the Y.Doc, so editor-driven changes flow
      // through the same path.
      yDocUpdateHandler = () => {
        if (!saveReady) return;
        scheduleSave();
        // Skip mount-time normalization churn — only genuine edits (preceded
        // by a canvas interaction) belong in history.
        if (!capturingHistorySnapshot && canvasInteracted)
          historyCapture.schedule();
      };
      localYDoc.on('update', yDocUpdateHandler);
      saveReady = true;

      lastSeenPushed = tree.notesById[noteId]?.pushed ?? false;
      await setupExcalidrawRoom();
      collabReady = true;

      unsubSession = onSessionChange(() => {
        void setupExcalidrawRoom();
      });

      // Merge fresh yrs_state into the live Y.Doc whenever sync pulls
      // this note. Same Yjs CRDT-merge story as NoteEditor — local
      // edits stay, pulled state converges, re-applying an already-
      // known update is a no-op. The Excalidraw island observes the
      // resulting Y.Doc changes via the bridge in excalidraw-yjs.
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
      void listen('collab-credentials-changed', (payload) => {
        if (collabCredentialsChangedForNote(payload, noteId)) {
          void setupExcalidrawRoom();
        }
      }).then((unlisten) => {
        unsubCollabCredentials = unlisten;
      });

      loading = false;

      // Register with the command bus. No commands to handle yet —
      // the catalogue carries zero freeform commands — but installing
      // the listener still matters: it displaces any markdown
      // listener above it on the stack so editor-scoped commands
      // don't accidentally route to a hidden markdown note while the
      // user is in a freeform canvas. Returning `false` from
      // `onCommand` tells the bus nothing was handled, so the manager
      // lets the keystroke flow through to Excalidraw.
      if (mountEl) {
        editorListener = {
          kind: 'freeform',
          host: mountEl,
          onCommand: (id: string) => {
            // No freeform commands yet. The bus only routes ids
            // whose `editorKind` is `'freeform'`, so reaching this
            // means a future catalogue addition wasn't accompanied
            // by an action here — log it.
            console.warn('[FreeformNoteEditor] unhandled command', id);
            return false;
          }
        };
        registerEditor(editorListener);
      }

      unregisterHistory = registerNoteHistory(noteId, {
        currentSnapshot: () => currentFreeformSnapshot(),
        restoreSnapshot: (snapshot) => restoreFreeformSnapshot(snapshot),
        snapshotNow: () => historyCapture.snapshotNow()
      });
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      loading = false;
      console.error('[FreeformNoteEditor] load failed', err);
    }
  });

  /**
   * Re-promote on focusin — same rationale as NoteEditor: two open
   * notes need the most recently focused one to win.
   */
  $effect(() => {
    if (!mountEl || !editorListener) return;
    const listener = editorListener;
    const onFocusIn = () => registerEditor(listener);
    mountEl.addEventListener('focusin', onFocusIn);
    return () => mountEl?.removeEventListener('focusin', onFocusIn);
  });

  // Arm history capture on the first real interaction with the canvas, so the
  // mount-time scene-normalization write never snapshots a no-edit version.
  // Capture phase so we see the event before Excalidraw can stop it.
  $effect(() => {
    if (!mountEl) return;
    const el = mountEl;
    const onInteract = () => {
      canvasInteracted = true;
    };
    el.addEventListener('pointerdown', onInteract, true);
    el.addEventListener('keydown', onInteract, true);
    return () => {
      el.removeEventListener('pointerdown', onInteract, true);
      el.removeEventListener('keydown', onInteract, true);
    };
  });

  // Re-render the island whenever any prop Excalidraw cares about flips —
  // currently trashed state (toggles the canvas to read-only mid-session)
  // and the app-wide colour scheme. The island maps each prop into the
  // matching Excalidraw API
  // inside its own useEffect; React reconciliation between renders keeps
  // Excalidraw's internal state intact.
  $effect(() => {
    const readOnly = isTrashed;
    const colorScheme = $userPrefersMode ?? 'system';
    const currentPenMode = penMode;
    const currentReduceMotion = reduceMotion;
    if (!reactRoot || !ExcalidrawIslandComponent || !reactCreateElement) return;
    if (!yDoc) return;
    reactRoot.render(
      reactCreateElement(ExcalidrawIslandComponent, {
        yDoc,
        readOnly,
        noteId,
        colorScheme,
        penMode: currentPenMode,
        reduceMotion: currentReduceMotion,
        onApiReady: handleExcalidrawApi
      })
    );
  });

  $effect(() => {
    const pushed = tree.notesById[noteId]?.pushed ?? false;
    if (!collabReady) return;
    if (pushed === lastSeenPushed) return;
    lastSeenPushed = pushed;
    void setupExcalidrawRoom();
  });

  function handleExcalidrawApi(api: ExcalidrawImperativeAPI | null): void {
    excalidrawApi = api;
    if (api) {
      // The room client needs the live API to push remote scenes into
      // updateScene and to read local elements off getSceneElements.
      // The island fires this callback right after mount, before any
      // user edit; setup is idempotent (destroys the prior client) so
      // calling it from both here and the load/session/pushed paths is
      // safe.
      void setupExcalidrawRoom();
    } else if (roomClient) {
      // API gone (island unmounted ahead of us). Tear down so the
      // socket doesn't keep emitting against a dead reference.
      roomClient.destroy();
      roomClient = null;
      collabOnline = false;
    }
  }

  async function setupExcalidrawRoom() {
    if (roomClient) {
      roomClient.destroy();
      roomClient = null;
      collabOnline = false;
    }
    collabConfigured = false;

    // Derived from the single account.serverUrl setting: socket.io
    // appends /socket.io/ which nginx routes to excalidraw-room (see
    // backend/nginx/nginx.conf).
    const collabUrl = getExcalidrawRoomUrl(
      (getSettingValue('account.serverUrl') as string | undefined) ?? ''
    );
    if (!collabUrl) return;
    if (!excalidrawApi) return;

    try {
      const signingMaterial = await getOrCreateCollabSigningMaterial();
      const room = await noteRoomInfo(noteId, signingMaterial?.publicKeyB64);
      if (!room || !excalidrawApi) return;
      const keyBytes16 = await deriveExcalidrawKey(base64ToBytes(room.key_b64));
      // Re-check the api after the awaits in case the panel was
      // dismantled while we were fetching room info / deriving the key.
      if (!excalidrawApi) return;
      collabConfigured = true;
      roomClient = new ExcalidrawRoomClient({
        url: collabUrl,
        roomId: room.room_id,
        keyBytes16,
        api: excalidrawApi,
        auth: collabAuthForRoom(room, signingMaterial),
        requireSignedWrites: room.collab_epoch > 0,
        onAuthStale: () => {
          void setupExcalidrawRoom();
        },
        onStatusChange: (online) => {
          collabOnline = online;
        }
      });
    } catch (err) {
      console.debug('[FreeformNoteEditor] excalidraw-room init failed', err);
    }
  }

  onDestroy(() => {
    if (saveTimer) clearTimeout(saveTimer);
    historyCapture.cancel();
    void historyCapture.capture('edited');
    unregisterHistory?.();
    unregisterHistory = null;
    if (editorListener) {
      unregisterEditor(editorListener);
      editorListener = null;
    }
    unsubSession?.();
    unsubSync?.();
    unsubCollabCredentials?.();
    unsubSync = null;
    unsubCollabCredentials = null;
    unsubSession = null;
    // Release our fullscreen ref if mobile auto-mode acquired one.
    // Ref-counted in the helper, so multiple freeform notes only flip
    // back out of fullscreen once the last one closes.
    if (fullscreenAcquired) {
      void releaseFullscreen();
      fullscreenAcquired = false;
    }
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
    ExcalidrawIslandComponent = null;
    reactCreateElement = null;

    if (yDoc && yDocUpdateHandler) yDoc.off('update', yDocUpdateHandler);
    yDocUpdateHandler = null;
    roomClient?.destroy();
    roomClient = null;
    excalidrawApi = null;
    collabOnline = false;
    collabConfigured = false;
    yDoc?.destroy();
    yDoc = null;
  });

  // ---- Save (debounced) ----

  function currentFreeformSnapshot(): string {
    if (!yDoc) return serializeYjsSnapshot('freeform', new Uint8Array());
    return serializeYjsSnapshot('freeform', Y.encodeStateAsUpdate(yDoc));
  }

  function restoreFreeformSnapshot(body: string): void {
    if (!yDoc) return;
    const parsed = parseHistorySnapshot(body, 'freeform');
    if (parsed.noteKind !== 'freeform') return;

    const snapshotDoc = new Y.Doc();
    if (parsed.bytes.byteLength > 0) {
      Y.applyUpdate(snapshotDoc, parsed.bytes);
    }
    try {
      const snapshot = readSceneFromYDoc(snapshotDoc);
      capturingHistorySnapshot = true;
      replaceSceneInYDoc(yDoc, snapshot);
    } finally {
      capturingHistorySnapshot = false;
      snapshotDoc.destroy();
    }
  }

  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!yDoc || isTrashed) return;
    try {
      savingState = 'saving';
      const yrsState = Array.from(Y.encodeStateAsUpdate(yDoc));
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
  }

  function scheduleSave() {
    if (isTrashed) return;
    savingState = 'pending';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), SAVE_DEBOUNCE_MS);
  }

  function base64ToBytes(b64: string): Uint8Array {
    const standard = b64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Mirror our reactive status into the global per-note store so the
  // dockview right-header (NoteStatusIcons.svelte) renders the icons
  // next to the popout button. Same plumbing NoteEditor uses; the
  // store is note_kind-agnostic.
  $effect(() => {
    setNoteStatus(noteId, {
      collabConfigured,
      collabOnline,
      savingState,
      isTrashed,
      // View-only share scope isn't enforced in the freeform editor yet.
      readOnly: false
    });
  });
</script>

<div class="flex h-full w-full flex-col">
  {#if isTrashed}
    <div
      class="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive"
      role="status"
    >
      <Trash2 class="size-3.5 shrink-0" aria-hidden="true" />
      <span
        >This note is in the trash and is read-only. Restore it to edit.</span
      >
    </div>
  {/if}
  <!--
    Excalidraw sizes itself to the containing block. The
    mount div needs `position: relative` to be that absolute's containing
    block, and `flex-1 min-h-0` so it actually claims the remaining
    column height inside the surrounding flex layout.
  -->
  <div class="relative min-h-0 w-full flex-1">
    {#if loading}
      <p
        class="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground"
      >
        Loading drawing…
      </p>
    {:else if loadError}
      <p
        class="absolute inset-0 flex items-center justify-center px-2 text-sm text-destructive"
      >
        Couldn't load drawing: {loadError}
      </p>
    {/if}
    <!--
      `freeform-canvas-host` gives app.css one stable, editor-agnostic
      hook for dockview drag routing and local canvas tweaks.
    -->
    <div
      bind:this={mountEl}
      class="freeform-canvas-host absolute inset-0"
    ></div>
  </div>
</div>
