<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { Crepe } from '@milkdown/crepe';
  import { editorViewCtx, serializerCtx, schemaCtx } from '@milkdown/kit/core';
  import { collabServiceCtx } from '@milkdown/plugin-collab';
  import * as Y from 'yjs';
  import { Awareness } from 'y-protocols/awareness';
  import {
    loadNote,
    saveNote as apiSaveNote,
    TRASH_ID,
    noteRoomInfo,
    etebaseSession,
    authSession,
    getYjsRelayUrl,
    onSessionChange,
    captureNoteVersion,
    getCollectionShareState,
    type VersionAction
  } from '$lib/api';
  import { tree } from '$lib/stores/tree.svelte';
  import {
    collectionScopeIsReadOnly,
    collectionIsSharedWithMe,
    collectionIsSharedByMe
  } from '$lib/stores/note-source.svelte';
  import {
    bumpNoteHistory,
    registerNoteHistory
  } from '$lib/stores/note-history-bridge.svelte';
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
  import { seedDeterministicTemplate } from '$lib/editor/seed-template';
  import { ensureDropIndicatorAlignment } from '$lib/editor/drop-indicator-align';
  import { otherPeerCount } from '$lib/editor/awareness-presence';
  import { pickCursorColor } from '$lib/editor/cursor-color';
  import { base64ToBytes } from '$lib/editor/base64';
  import {
    createWikilinkBridge,
    createMarkdownSearchBridge,
    createUserMentionBridge,
    refreshMentionDecorations,
    type MentionUser
  } from '$lib/editor/plugins';
  import { MARKDOWN_ACTIONS } from '$lib/hotkeys/markdown-actions';
  import SourceEditor from '$lib/editor/source/SourceEditor.svelte';
  import EditorModeToggle from '$lib/editor/source/EditorModeToggle.svelte';
  import { SOURCE_ACTIONS } from '$lib/editor/source/source-actions';
  import {
    coerceViewMode,
    type EditorViewMode
  } from '$lib/editor/source/view-mode';
  import {
    blockLineStarts,
    computeSourcePresence
  } from '$lib/editor/source/source-presence';
  import type { PeerPresence } from '$lib/editor/source/source-presence-extension';
  import type { EditorView as CmEditorView } from '@codemirror/view';
  import {
    registerEditor,
    unregisterEditor,
    SEARCH_ACTIVE_NOTE_COMMAND,
    type EditorListener
  } from '$lib/hotkeys/bus.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import FindBar from './FindBar.svelte';
  import EditorToolbar from './editor-toolbar/EditorToolbar.svelte';
  import MobileEditorToolbar from './editor-toolbar/MobileEditorToolbar.svelte';
  import TrashBanner from './note-editor/TrashBanner.svelte';
  import ViewOnlyBanner from './note-editor/ViewOnlyBanner.svelte';
  import WikilinkMenu from './note-editor/WikilinkMenu.svelte';
  import UserMentionMenu from './note-editor/UserMentionMenu.svelte';

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
  const wikilinkOpenOnClick = $derived(
    (getSettingValue('editor.wikilinkOpenOnClick') as boolean | undefined) ??
      true
  );
  const userMentionsEnabled = $derived(
    (getSettingValue('editor.userMentions') as boolean | undefined) ?? true
  );
  const sourceTabSize = $derived.by(() => {
    const v = Number(getSettingValue('editor.tabSize'));
    return Number.isFinite(v) && v > 0 ? Math.min(8, v) : 2;
  });

  // Per-editor bridge between the wikilink trigger plugin and the
  // WikilinkMenu popup. Created up-front (cheap; just a $state object)
  // so the popup template never has to defend against `bridge == null`
  // — if wikilinks are off, the plugin simply never opens it.
  const wikilinkBridge = createWikilinkBridge();

  // Per-editor bridge for `@username` mentions. Same up-front-creation
  // rationale as the wikilink bridge. Unlike wikilinks (candidates read
  // synchronously from the tree), the mention candidate list — "who can view
  // this note" — is resolved asynchronously below and written to
  // `userMentionBridge.state.users`.
  const userMentionBridge = createUserMentionBridge();

  // Per-editor find & replace bridge. The search prose plugin (registered
  // in crepe-setup) reports match counts through `searchBridge.state`; the
  // FindBar below drives it via the handler functions. See the
  // `--- In-document find & replace ---` block lower down.
  const searchBridge = createMarkdownSearchBridge();
  let searchOpen = $state(false);
  let searchQuery = $state('');
  let replaceValue = $state('');
  // VS Code-style modifiers; persisted across open/close and re-applied to
  // the plugin on open (closing clears the plugin's copy).
  let searchOptions = $state({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    preserveCase: false
  });
  let searchBar = $state<{ focus: () => void } | null>(null);

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
  // --- View mode (WYSIWYG / Source / Split) ---------------------------------
  // Seeded from the editor.defaultMode setting in onMount (mobile forces
  // WYSIWYG). Crepe stays mounted as the Yjs authority in every mode; the
  // source editor is a CodeMirror reflection kept in sync below.
  let viewMode = $state<EditorViewMode>('wysiwyg');
  // Which surface last had focus — drives toolbar/hotkey routing (WYSIWYG runs
  // ProseMirror commands, Source runs markdown text transforms). In Split it
  // tracks the pane the user last interacted with.
  let activeSurface = $state<'wysiwyg' | 'source'>('wysiwyg');
  // Wrapper around BOTH panes, registered as the command-bus listener host so
  // the hotkey manager treats the source editor's contenteditable as part of
  // this editor (otherwise its keystrokes would be filtered as blocked input).
  let editorRegionEl: HTMLDivElement | null = $state(null);
  // Imperative handle to the source editor (null unless the source pane is up).
  let sourceEditor = $state<{
    setText: (text: string) => void;
    setPresence: (presence: PeerPresence[]) => void;
    flush: () => void;
    focus: () => void;
    getView: () => CmEditorView | null;
  } | null>(null);
  let sourceSyncTimer: ReturnType<typeof setTimeout> | null = null;
  // Tracks the previous active surface so we can detect a source→WYSIWYG
  // hand-off and reconcile the source view to the canonical document then.
  let prevActiveSurface: 'wysiwyg' | 'source' = 'wysiwyg';
  // --- Source presence (Phase 2) --------------------------------------------
  // Peers' cursors are decoded to source lines and pushed into the source
  // editor. The block→line table is cached against the PM doc identity so
  // awareness-only changes (peers moving) don't re-serialize the whole doc.
  let presenceTimer: ReturnType<typeof setTimeout> | null = null;
  let presenceCacheDoc: unknown = null;
  let presenceLineStarts: number[] = [];
  let awarenessChangeHandler: (() => void) | null = null;
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
  let yDocUpdateHandler:
    | ((update: Uint8Array, origin: unknown) => void)
    | null = null;
  /** Transaction origin tag for a yrs_state re-applied by handleSyncCompleted.
   *  That state was just read from SQLite, so it's already persisted — the
   *  update handler uses this to skip the redundant re-save (which would only
   *  re-mark the row dirty and re-push it). */
  const REMOTE_SYNC_ORIGIN = Symbol('mindstream:sync-completed-merge');

  // --- Note history (local, automatic versioning) ---------------------------
  // A version is captured after the user pauses editing (idle debounce), once
  // enough visible characters change since the last snapshot (so long
  // uninterrupted sessions still get versions), and on teardown. Both the idle
  // delay and the character threshold are user-configurable (advanced data
  // settings); these are the fallback defaults. The backend dedups identical
  // snapshots and promotes the first to 'created'.
  const HISTORY_IDLE_DEFAULT_S = 180;
  const HISTORY_TOKENS_DEFAULT = 200;
  let historyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Edits have landed since the last capture (so teardown should flush one). */
  let historyDirty = false;
  /** Non-whitespace char count of the last captured snapshot (threshold base). */
  let lastSnapshotTokens = 0;
  /** Throttle for the (serializing) token-threshold check. */
  let lastTokenCheck = 0;
  let unregisterHistory: (() => void) | null = null;
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
  //   1. The note is moved into the special 'trash' collection, but
  //      trashed_at stays NULL.
  //   2. The note's *containing folder* (or any ancestor folder) is in
  //      trash. The note's own parent_collection_id doesn't change in
  //      this case — only an ancestor walk catches it.
  //   3. The note has been purged remotely while the tab is still open —
  //      same "missing from tree" signature as (2). We treat it as
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

  // The note sits in a folder shared *with* this user at read-only access.
  // Like `isTrashed`, this locks the editor — but for a different reason and
  // with a different (neutral) banner. Gated on tree.ready to avoid flashing
  // the banner before the initial tree hydration resolves the share role.
  const isReadOnlyScope = $derived.by(() => {
    if (!tree.ready) return false;
    const n = tree.notesById[noteId];
    if (!n) return false;
    return collectionScopeIsReadOnly(
      n.parent_collection_id,
      tree.collectionsById
    );
  });

  // Anything that should disable editing. Trashed keeps its own banner and save
  // semantics; the read-only scope reuses the same input lock (setReadonly,
  // hidden toolbar, no replace) so a viewer can't type into content they can't
  // push.
  const isReadOnly = $derived(isTrashed || isReadOnlyScope);

  /**
   * The nearest ancestor collection (or the note's own folder) that carries a
   * share — the "share scope". Its members are the people who can view the
   * note. Returns null for a purely personal note (candidate list is then just
   * yourself). Cycle-guarded like the trash walk above.
   */
  function findShareScopeCollectionId(parentId: string | null): string | null {
    let current = parentId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const c = tree.collectionsById[current];
      if (!c) return null;
      if (collectionIsSharedWithMe(c) || collectionIsSharedByMe(c)) {
        return current;
      }
      current = c.parent_collection_id;
    }
    return null;
  }

  // Resolve "who can view this note" for the mention dropdown: yourself, plus —
  // when the note lives in a shared scope — the scope's owner and members. The
  // share state is an async backend call, so we write the result into the
  // bridge and (once resolved) nudge the decoration plugin to re-evaluate the
  // "self" highlight on any mentions that rendered before the session/list was
  // known. Reads authSession + tree so it re-runs on sign-in/out and moves.
  $effect(() => {
    const me = authSession.current?.username ?? null;
    const selfOnly: MentionUser[] = me
      ? [{ username: me, accessLevel: null, isSelf: true }]
      : [];
    const note = tree.notesById[noteId];
    const scopeId = note
      ? findShareScopeCollectionId(note.parent_collection_id)
      : null;

    if (!scopeId) {
      userMentionBridge.state.users = selfOnly;
      return;
    }

    let cancelled = false;
    void getCollectionShareState(scopeId)
      .then((share) => {
        if (cancelled) return;
        const users: MentionUser[] = [];
        const seen = new Set<string>();
        const add = (
          username: string | null,
          accessLevel: MentionUser['accessLevel']
        ) => {
          const name = username?.trim();
          if (!name) return;
          const key = name.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          users.push({
            username: name,
            accessLevel,
            isSelf: me !== null && me.toLowerCase() === key
          });
        };
        add(me, null); // self first
        add(share.shared_owner, null);
        for (const member of share.members)
          add(member.username, member.access_level);
        userMentionBridge.state.users = users;
        if (crepe) {
          try {
            crepe.editor.action((ctx) =>
              refreshMentionDecorations(ctx.get(editorViewCtx))
            );
          } catch {
            // Editor not fully materialised yet; the next doc change rebuilds.
          }
        }
      })
      .catch(() => {
        if (!cancelled) userMentionBridge.state.users = selfOnly;
      });
    return () => {
      cancelled = true;
    };
  });

  onMount(async () => {
    if (!host) return;
    try {
      mobile = isMobile();
      viewMode = mobile
        ? 'wysiwyg'
        : coerceViewMode(getSettingValue('editor.defaultMode'));
      activeSurface = 'wysiwyg';
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
        wikilinkOpenOnClick: () => wikilinkOpenOnClick,
        wikilinkBridge,
        userMentionsEnabled,
        userMentionBridge,
        currentUsername: () => authSession.current?.username ?? null,
        searchBridge,
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
          host: editorRegionEl ?? host,
          noteId,
          onCommand: (id: string) => {
            // Editor-agnostic "find in this note" broadcast — open the
            // in-document find & replace bar. Handled before the markdown
            // action lookup since it isn't an `editor.markdown.*` command.
            if (id === SEARCH_ACTIVE_NOTE_COMMAND) {
              openSearch();
              return true;
            }
            // Cycle the editor surface. Handled before the source branch so it
            // works from either pane; no-op on mobile (single WYSIWYG surface).
            if (id === 'editor.markdown.cycleViewMode') {
              if (mobile) return false;
              cycleViewMode();
              return true;
            }
            // Source surface active → run the markdown *text* transform on the
            // CodeMirror view instead of the ProseMirror command. The same
            // command ids drive both surfaces (see SOURCE_ACTIONS), so the
            // shared toolbar and hotkeys "just work" against the raw source.
            if (activeSurface === 'source') {
              const view = sourceEditor?.getView() ?? null;
              const srcAction = view ? SOURCE_ACTIONS[id] : undefined;
              if (view && srcAction) {
                try {
                  srcAction(view);
                  return true;
                } catch (err) {
                  console.error('[NoteEditor] source command threw', id, err);
                  return false;
                }
              }
              return false;
            }
            const action = MARKDOWN_ACTIONS[id];
            // A missing markdown action for an `editor.markdown.*` id is
            // catalogue drift (a hotkey command registered without a
            // matching action) and worth a warning. App-level ids (e.g.
            // the editor-agnostic `app.searchActiveNote` broadcast) are
            // expected to land here unhandled until markdown wires them
            // up — return `false` quietly so the keystroke falls through.
            if (!action) {
              if (id.startsWith('editor.markdown.')) {
                console.warn('[NoteEditor] unknown markdown command', id);
              }
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
          // Empty doc → seed the fragment from the markdown body. Use a
          // DETERMINISTIC origin (fixed client id) instead of cs.applyTemplate,
          // whose throwaway doc gets a random client id: seeded/demo notes are
          // created independently on every device, so a random origin makes a
          // merge stack both copies and duplicate the body. A shared origin
          // collapses to one; live edits still diverge on the live doc's own
          // client id. See $lib/editor/seed-template.
          seedDeterministicTemplate(ctx, yDoc!, note.body);
        }
        cs.connect();

        const serializer = ctx.get(serializerCtx);
        const view = ctx.get(editorViewCtx);
        getMarkdown = () => serializer(view.state.doc);
      });

      // Hook yDoc updates AFTER bind/applyTemplate/connect so the initial
      // fragment population doesn't trip a phantom save. From here on, a doc
      // mutation — a local keystroke (via y-prosemirror's ySyncPlugin) or a
      // peer edit applied by the CollabProvider — schedules a debounced save.
      // The one exception is a state re-applied by handleSyncCompleted
      // (REMOTE_SYNC_ORIGIN): it's already on disk, so it skips the save (see
      // below). We don't go through the listener plugin's `markdownUpdated`
      // because it filters out transactions with `addToHistory === false`,
      // which is exactly what y-prosemirror sets on remote-applied syncs — i.e.
      // peer edits would update the visible editor but never reach SQLite until
      // the local user typed.
      yDocUpdateHandler = (_update, origin) => {
        if (!saveReady) return;
        // handleSyncCompleted re-applies the note's freshly-pulled yrs_state to
        // keep the open editor's live doc current. That state was just read
        // from SQLite, so it's already persisted — re-saving it only re-marks
        // the row dirty and re-pushes it, ping-ponging with the peer (and
        // amplifying any transient divergence into duplicated content under a
        // slow/lagging sync). Skip the save for that origin; the doc and DB
        // already agree. Peer edits arriving over the live relay carry a
        // different origin and still save, so they persist locally as before.
        if (origin !== REMOTE_SYNC_ORIGIN) scheduleSave();
        scheduleHistoryCapture();
        // Mirror the doc into the source editor when it's visible — but
        // ORIGIN-GATED. While the user is editing the source pane, we must not
        // push our OWN edit's normalized round-trip back over their text
        // (Milkdown reformats in-progress markdown — e.g. empty list items —
        // and that would fight the caret). Remote peers' edits (applied by the
        // CollabProvider or a background-sync merge) ARE still pushed, so the
        // source stays convergent — which is also what keeps the next
        // source→doc overwrite from clobbering those remote changes.
        if (viewMode !== 'wysiwyg') {
          const isRemote =
            (provider !== null && origin === provider) ||
            origin === REMOTE_SYNC_ORIGIN;
          if (isRemote || activeSurface !== 'source') scheduleSourceSync();
        }
        // Positions and the block→line table shift with the doc, so remote
        // presence markers need re-mapping.
        scheduleSourcePresence();
      };
      localYDoc.on('update', yDocUpdateHandler);
      saveReady = true;
      // If the note opened directly in Source/Split, the source editor mounted
      // before Crepe bound (getMarkdown was null then) — seed it now.
      if (viewMode !== 'wysiwyg' && sourceEditor && getMarkdown) {
        sourceEditor.setText(getMarkdown());
      }

      // Refresh source presence whenever a peer's cursor moves / they join or
      // leave. The refresh self-gates on the active surface and clears markers
      // when the source pane isn't in use.
      awarenessChangeHandler = () => scheduleSourcePresence();
      localAwareness.on('change', awarenessChangeHandler);
      scheduleSourcePresence();

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

      // Expose restore + current-markdown to the History sidebar section,
      // which can't reach the live editor (and its Yjs doc) by props.
      unregisterHistory = registerNoteHistory(noteId, {
        restoreSnapshot: (markdown) => applyMarkdownTemplate(markdown),
        currentSnapshot: () => (getMarkdown ? getMarkdown() : ''),
        snapshotNow: () => snapshotHistoryNow(),
        peerCount: () => otherPeerCount(awareness),
        setCollabPaused: (paused) => setE2eCollabPaused(paused)
      });

      // Snapshot a baseline on open so a note that's never edited still starts
      // its timeline (the backend promotes the first version to 'created' and
      // dedups, so reopening unchanged content is a no-op). This does NOT mark
      // the session dirty — it's the loaded state, not a user edit.
      void captureHistoryVersion('edited');
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
  let e2eCollabPaused = false;

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
    if (e2eCollabPaused) return;

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

  async function setE2eCollabPaused(paused: boolean): Promise<void> {
    e2eCollabPaused = paused;
    if (paused) {
      if (provider) {
        provider.destroy();
        provider = null;
      }
      collabOnline = false;
      collabConfigured = false;
      return;
    }
    await setupCollabProvider();
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
          // Tag the origin so yDocUpdateHandler skips the redundant re-save:
          // these bytes came straight from SQLite, so the row is already
          // up to date and pushing it again would only ping-pong with the peer.
          Y.applyUpdate(
            yDoc,
            new Uint8Array(fresh.yrs_state),
            REMOTE_SYNC_ORIGIN
          );
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
    if (!editorRegionEl || !editorListener) return;
    const region = editorRegionEl;
    const listener = editorListener;
    const onFocusIn = (e: FocusEvent) => {
      // registerEditor is the "re-promote" path too: if the listener
      // is already registered it gets moved to the top of the stack.
      registerEditor(listener);
      // Track which pane the user is in so the shared toolbar and hotkeys
      // target it. The region wraps both panes; anything inside the Crepe
      // host is the WYSIWYG surface, everything else is the source editor.
      const target = e.target as Node | null;
      activeSurface =
        host && target && host.contains(target) ? 'wysiwyg' : 'source';
    };
    region.addEventListener('focusin', onFocusIn);
    return () => region.removeEventListener('focusin', onFocusIn);
  });

  onDestroy(() => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      void persistCurrentNote({ updateStatus: false }).catch((err) => {
        console.error('[NoteEditor] final save failed', err);
      });
    }
    // Flush a final history version for edits made since the last capture,
    // while the editor (and getMarkdown) is still alive. Fire-and-forget —
    // the backend dedups, so a no-op close is harmless.
    if (historyTimer) {
      clearTimeout(historyTimer);
      historyTimer = null;
    }
    if (historyDirty) void captureHistoryVersion('edited');
    if (sourceSyncTimer) {
      clearTimeout(sourceSyncTimer);
      sourceSyncTimer = null;
    }
    if (presenceTimer) {
      clearTimeout(presenceTimer);
      presenceTimer = null;
    }
    if (awareness && awarenessChangeHandler) {
      awareness.off('change', awarenessChangeHandler);
    }
    awarenessChangeHandler = null;
    presenceCacheDoc = null;
    unregisterHistory?.();
    unregisterHistory = null;
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

  // Push the read-only state into Crepe whenever either side changes.
  // Re-runs when crepeReady flips (handles the initial-state case for a
  // note that was already trashed / in a view-only share when the tab
  // opened) and when the lock changes (remote pull, local restore from
  // another window, or a share's access level changing under us).
  $effect(() => {
    if (!crepeReady || !crepe) return;
    crepe.setReadonly(isReadOnly);
  });

  // React to the active surface / view mode changing.
  $effect(() => {
    const surface = activeSurface;
    const mode = viewMode;
    void crepeReady;
    // Source → WYSIWYG hand-off (Split): reconcile the source view to the
    // canonical document now. Per the "only overwrite source on WYSIWYG
    // interaction / close" rule, we don't overwrite the source pane while it's
    // the active surface; leaving it is when we resync. Flush any pending
    // source edit first so trailing keystrokes reach the doc before we
    // re-serialize it back.
    if (
      mode === 'split' &&
      surface === 'wysiwyg' &&
      prevActiveSurface === 'source'
    ) {
      sourceEditor?.flush();
      scheduleSourceSync();
    }
    prevActiveSurface = surface;
    // Only the surface being used renders peer markers.
    scheduleSourcePresence();
  });

  /**
   * Apply `markdown` to the live document as collaborative edits. The collab
   * service diffs the current doc against the template and emits y-prosemirror
   * ops (the `() => true` condition forces the apply even on a non-empty doc).
   * Those ops trigger the normal save + broadcast path, so a restore converges
   * across devices like any other edit. Used by the History sidebar's Restore.
   */
  function applyMarkdownTemplate(markdown: string) {
    if (!crepe || isReadOnly) return;
    try {
      crepe.editor.action((ctx) => {
        ctx.get(collabServiceCtx).applyTemplate(markdown, () => true);
      });
    } catch (err) {
      console.error('[NoteEditor] applyTemplate (restore) failed', err);
    }
  }

  /**
   * Switch this note's editor surface. WYSIWYG/Source set the active surface
   * directly; Split keeps whatever pane was last used. Focus follows the new
   * surface after the DOM updates.
   */
  function cycleViewMode() {
    const order: EditorViewMode[] = ['wysiwyg', 'source', 'split'];
    const next = order[(order.indexOf(viewMode) + 1) % order.length];
    selectViewMode(next);
  }

  function selectViewMode(mode: EditorViewMode) {
    if (mode === viewMode) return;
    viewMode = mode;
    if (mode === 'wysiwyg') activeSurface = 'wysiwyg';
    else if (mode === 'source') activeSurface = 'source';
    void tick().then(() => {
      if (mode === 'wysiwyg') focusEditorView();
      else if (mode === 'source') sourceEditor?.focus();
      // Split: leave focus where the user put it.
    });
  }

  /**
   * A genuine edit in the raw-source editor. Feed it into the live doc through
   * the same collab applyTemplate path history-restore uses. The doc update this
   * triggers is local-origin, so the origin gate in yDocUpdateHandler skips the
   * echo back into the source editor (it would fight the caret) while still
   * echoing remote peers' edits.
   */
  function handleSourceInput(markdown: string) {
    if (isReadOnly) return;
    applyMarkdownTemplate(markdown);
  }

  /** Debounced doc → source refresh: serialize the live doc and push it into
   *  the source editor (a no-op when the text is unchanged). */
  function scheduleSourceSync() {
    if (sourceSyncTimer) clearTimeout(sourceSyncTimer);
    sourceSyncTimer = setTimeout(() => {
      sourceSyncTimer = null;
      if (getMarkdown && sourceEditor) sourceEditor.setText(getMarkdown());
    }, 120);
  }

  /** Coalesced trigger for a source-presence refresh — awareness 'change'
   *  events can fire rapidly while peers type. */
  function scheduleSourcePresence() {
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = null;
      refreshSourcePresence();
    }, 80);
  }

  /**
   * Decode peers' cursors to source lines and push them into the source editor.
   * Only the active source surface shows markers (per the one-side-at-a-time
   * decision); every other state clears them. The block→line table is rebuilt
   * only when the ProseMirror doc identity changes.
   */
  function refreshSourcePresence() {
    const editor = sourceEditor;
    if (!editor) return;
    if (
      !crepe ||
      viewMode === 'wysiwyg' ||
      activeSurface !== 'source' ||
      !awareness
    ) {
      editor.setPresence([]);
      return;
    }
    const aware = awareness;
    try {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (view.state.doc !== presenceCacheDoc) {
          const serializer = ctx.get(serializerCtx);
          const schema = ctx.get(schemaCtx);
          const blocks: string[] = [];
          view.state.doc.forEach((block) => {
            try {
              // Trim the serializer's trailing newline so each block's line
              // count reflects only its own content (blockLineStarts adds the
              // blank separator between blocks itself).
              const md = serializer(
                schema.topNodeType.create(null, block)
              ).replace(/\n+$/, '');
              blocks.push(md);
            } catch {
              blocks.push('');
            }
          });
          presenceLineStarts = blockLineStarts(blocks);
          presenceCacheDoc = view.state.doc;
        }
        editor.setPresence(
          computeSourcePresence(view, aware, presenceLineStarts)
        );
      });
    } catch (err) {
      console.debug('[NoteEditor] source presence refresh failed', err);
    }
  }

  /**
   * Capture the current state immediately (deduped) and reset the idle timer.
   * Invoked by the History panel's refresh button — an explicit refresh should
   * also snapshot what the user is currently looking at, and clearing the
   * pending idle timer means the next auto-capture is measured from now.
   */
  async function snapshotHistoryNow() {
    if (historyTimer) {
      clearTimeout(historyTimer);
      historyTimer = null;
    }
    await captureHistoryVersion('edited');
  }

  function nonWhitespaceCount(s: string): number {
    return s.replace(/\s+/g, '').length;
  }

  /** Configured idle delay (ms) before an auto-snapshot; default 3 min. */
  function historyIdleMs(): number {
    const v = Number(getSettingValue('data.historyIdleSeconds'));
    return (Number.isFinite(v) && v > 0 ? v : HISTORY_IDLE_DEFAULT_S) * 1000;
  }

  /** Configured number of changed visible chars that forces a snapshot. */
  function historyTokenThreshold(): number {
    const v = Number(getSettingValue('data.historyTokenThreshold'));
    return Number.isFinite(v) && v > 0 ? v : HISTORY_TOKENS_DEFAULT;
  }

  /**
   * Called on every editor change. Arms the idle-debounce snapshot, and — so a
   * long uninterrupted session still gets versions — snapshots immediately once
   * the configured number of visible characters has changed since the last one.
   * The (serializing) token check is throttled so fast typing doesn't re-render
   * markdown on every keystroke.
   */
  function scheduleHistoryCapture() {
    if (isReadOnly) return;
    historyDirty = true;

    const now = Date.now();
    if (getMarkdown && now - lastTokenCheck >= 750) {
      lastTokenCheck = now;
      const tokens = nonWhitespaceCount(getMarkdown());
      if (Math.abs(tokens - lastSnapshotTokens) >= historyTokenThreshold()) {
        if (historyTimer) {
          clearTimeout(historyTimer);
          historyTimer = null;
        }
        void captureHistoryVersion('edited');
        return;
      }
    }

    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = setTimeout(() => {
      historyTimer = null;
      void captureHistoryVersion('edited');
    }, historyIdleMs());
  }

  async function captureHistoryVersion(action: VersionAction) {
    if (!getMarkdown) return;
    historyDirty = false;
    const markdown = getMarkdown();
    // Reset the token-threshold baseline to the snapshot we're taking (even on
    // a no-op dedup the content is now the baseline, so we don't re-fire).
    lastSnapshotTokens = nonWhitespaceCount(markdown);
    try {
      const created = await captureNoteVersion(
        noteId,
        'markdown',
        action,
        markdown
      );
      // Only nudge the sidebar when a version was actually written (a no-op
      // dedup returns null and shouldn't trigger a re-list).
      if (created) bumpNoteHistory(noteId);
    } catch (err) {
      console.debug('[NoteEditor] history capture failed', err);
    }
  }

  function scheduleSave() {
    // setReadonly(true) already prevents user input, but yDoc 'update' can
    // still fire from programmatic mutations or remote edits arriving on
    // a note that just got trashed (or shared read-only) elsewhere. Drop
    // those silently rather than persisting an edit we can't push anyway.
    if (isReadOnly) return;
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
        await persistCurrentNote();
      } catch (err) {
        savingState = 'error';
        console.error('[NoteEditor] save failed', err);
      }
    }, saveDebounceMs);
  }

  async function persistCurrentNote(
    opts: { updateStatus?: boolean } = {}
  ): Promise<void> {
    const updateStatus = opts.updateStatus ?? true;
    // Capture the markdown + y-doc state synchronously while the editor still
    // exists. This also lets onDestroy flush a pending debounce before Crepe
    // tears down the ProseMirror/Yjs state.
    const rawMarkdown = getMarkdown ? getMarkdown() : '';
    // Trim trailing whitespace per-line on the way to disk. We don't mutate
    // the live editor doc — that would jump the caret and broadcast a no-op
    // edit to peers; we only sanitise the snapshot we hand to Rust.
    const markdown = trimTrailingOnSave
      ? rawMarkdown.replace(/[ \t]+$/gm, '')
      : rawMarkdown;
    // Array.from is necessary because Tauri serialises Uint8Array as an empty
    // object via JSON.stringify.
    const yrsState = yDoc ? Array.from(Y.encodeStateAsUpdate(yDoc)) : undefined;
    await apiSaveNote({ id: noteId, body: markdown, yrs_state: yrsState });
    // Mirror the new modified timestamp in the local cache so the metadata
    // panel reflects the save without a tree refetch.
    const existing = tree.notesById[noteId];
    if (existing) {
      tree.notesById[noteId] = {
        ...existing,
        modified: new Date().toISOString()
      };
    }
    if (updateStatus) savingState = 'saved';
  }

  // --- In-document find & replace -------------------------------------------
  //
  // The heavy lifting (matching, decorations, navigation, replace) lives in
  // the search prose plugin; this side just owns the bar's open state + the
  // two field values and forwards user intent through `searchBridge`. Match
  // count / active index flow back via `searchBridge.state`.

  function focusEditorView() {
    if (!crepe) return;
    try {
      crepe.editor.action((ctx) => ctx.get(editorViewCtx).focus());
    } catch (err) {
      console.debug('[NoteEditor] focus editor failed', err);
    }
  }

  function openSearch() {
    searchOpen = true;
    // Restore the modifiers (a prior close cleared the plugin's copy) and
    // re-run the current query — covers reopening with text already typed.
    searchBridge.setOptions({ ...searchOptions });
    searchBridge.setQuery(searchQuery.trim());
    void tick().then(() => searchBar?.focus());
  }

  function closeSearch() {
    searchOpen = false;
    searchBridge.clear();
    focusEditorView();
  }

  function handleSearchInput(value: string) {
    searchQuery = value;
    searchBridge.setQuery(value.trim());
  }

  function handleReplaceInput(value: string) {
    replaceValue = value;
  }

  // Toggle a single modifier and push the new set into the plugin, which
  // recomputes matches against it.
  function toggleMatchCase() {
    searchOptions.caseSensitive = !searchOptions.caseSensitive;
    searchBridge.setOptions({ ...searchOptions });
  }
  function toggleWholeWord() {
    searchOptions.wholeWord = !searchOptions.wholeWord;
    searchBridge.setOptions({ ...searchOptions });
  }
  function toggleRegex() {
    searchOptions.regex = !searchOptions.regex;
    searchBridge.setOptions({ ...searchOptions });
  }
  function togglePreserveCase() {
    // Replace-only modifier — no need to recompute matches, but keep the
    // plugin's copy current so the next replace honours it.
    searchOptions.preserveCase = !searchOptions.preserveCase;
    searchBridge.setOptions({ ...searchOptions });
  }

  function doReplaceCurrent() {
    if (isReadOnly) return;
    searchBridge.replaceCurrent(replaceValue);
  }

  function doReplaceAll() {
    if (isReadOnly) return;
    searchBridge.replaceAll(replaceValue);
  }

  // Desktop toolbar visibility is a per-device toggle (default on). The
  // settings.values read makes this $derived re-evaluate when the user flips
  // the toggle live. Read-only notes (trashed or view-only share) hide the
  // toolbar too — it'd be misleading to show formatting buttons over a
  // read-only banner.
  const desktopToolbarEnabled = $derived(
    (settings.values['editor.desktopToolbar'] ?? true) as boolean
  );
  const showDesktopToolbar = $derived(
    !mobile && crepeReady && !isReadOnly && desktopToolbarEnabled
  );
  const showMobileToolbar = $derived(mobile && crepeReady && !isReadOnly);

  // The desktop editor header (mode toggle + optional toolbar) shows whenever
  // the desktop editor is interactive — including read-only notes, where the
  // toggle still lets you view the raw source.
  const showEditorHeader = $derived(!mobile && crepeReady);

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
      isTrashed,
      readOnly: isReadOnlyScope
    });
  });
</script>

<div class="flex h-full w-full flex-col">
  {#if showEditorHeader}
    <div
      class="flex items-center gap-1 border-b border-border bg-background pr-1"
    >
      <div class="min-w-0 flex-1">
        {#if showDesktopToolbar}
          <EditorToolbar
            {crepe}
            {activeSurface}
            menuPlacement="bottom"
            dense
            class="bg-background"
          />
        {/if}
      </div>
      <EditorModeToggle value={viewMode} onCycle={cycleViewMode} />
    </div>
  {/if}
  {#if isTrashed}
    <TrashBanner />
  {:else if isReadOnlyScope}
    <ViewOnlyBanner />
  {/if}
  {#if searchOpen}
    <!--
      Replace is gated on !isReadOnly: a read-only note (trashed or a
      view-only share) can still be searched, but the bar then collapses to
      find-only because the replace callbacks are omitted.
    -->
    <FindBar
      bind:this={searchBar}
      query={searchQuery}
      matchCount={searchBridge.state.matchCount}
      activeIndex={searchBridge.state.activeIndex}
      busy={false}
      placeholder={tUi('find.placeholder')}
      onInput={handleSearchInput}
      onNext={() => searchBridge.next()}
      onPrevious={() => searchBridge.previous()}
      onClose={closeSearch}
      matchCase={searchOptions.caseSensitive}
      wholeWord={searchOptions.wholeWord}
      useRegex={searchOptions.regex}
      onToggleMatchCase={toggleMatchCase}
      onToggleWholeWord={toggleWholeWord}
      onToggleRegex={toggleRegex}
      replaceValue={isReadOnly ? undefined : replaceValue}
      onReplaceInput={isReadOnly ? undefined : handleReplaceInput}
      onReplace={isReadOnly ? undefined : doReplaceCurrent}
      onReplaceAll={isReadOnly ? undefined : doReplaceAll}
      preserveCase={searchOptions.preserveCase}
      onTogglePreserveCase={isReadOnly ? undefined : togglePreserveCase}
    />
  {/if}
  <!--
    flex-1 + min-h-0 (not h-full) so the scroll area fills the *remaining*
    height after the desktop toolbar and trash banner take theirs.
    h-full was strict-100%-of-parent and could overflow the parent chrome,
    especially on mobile where focused content can tempt the webview to
    scroll the document body to "fix" it.
  -->
  <div
    bind:this={editorRegionEl}
    class="relative min-h-0 w-full flex-1 overflow-hidden"
    class:source-surface-active={activeSurface === 'source' &&
      viewMode !== 'wysiwyg'}
  >
    {#if loading}
      <p
        class="absolute left-0 top-0 z-10 px-6 py-4 text-sm text-muted-foreground"
      >
        Loading note…
      </p>
    {:else if loadError}
      <p class="absolute left-0 top-0 z-10 px-6 py-4 text-sm text-destructive">
        Couldn't load note: {loadError}
      </p>
    {/if}
    <div class="flex h-full w-full">
      <!--
        Source pane: raw-markdown CodeMirror mirror of the same doc. On the
        LEFT in Split (convention: source left, rendered right).
      -->
      {#if viewMode !== 'wysiwyg'}
        <div
          class="h-full overflow-hidden {viewMode === 'split'
            ? 'w-1/2 border-r border-border'
            : 'w-full'}"
        >
          <SourceEditor
            bind:this={sourceEditor}
            getInitialText={() => (getMarkdown ? getMarkdown() : '')}
            readonly={isReadOnly}
            tabSize={sourceTabSize}
            onInput={handleSourceInput}
          />
        </div>
      {/if}
      <!--
        WYSIWYG pane: always mounted — Crepe is the Yjs authority in every mode.
        Hidden in Source-only mode, half-width (right) in Split.
      -->
      <div
        class="themed-scrollbar h-full overflow-y-auto {viewMode === 'source'
          ? 'hidden'
          : ''} {viewMode === 'split' ? 'w-1/2' : 'w-full'}"
      >
        <div
          bind:this={host}
          class="mx-auto max-w-3xl"
          class:mobile-editor={mobile}
          class:wikilink-open-on-click={wikilinkOpenOnClick}
        ></div>
      </div>
    </div>
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

<!--
  User-mention popup — same portal/position:fixed story as WikilinkMenu, and
  likewise gated by `bridge.state.open` so it costs ~0 when mentions are off.
-->
<UserMentionMenu bridge={userMentionBridge} />
