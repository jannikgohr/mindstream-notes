<script lang="ts">
  /**
   * Editor for `note_kind === 'kanban'` notes.
   *
   * Architecture (mirrors the other collaborative editors): this component is
   * the shell. It owns the note's `Y.Doc`, hydrates it from `yrs_state`,
   * debounce-saves, and attaches the generic {@link CollabProvider} for live
   * co-editing once the note has been pushed — a Kanban board is just a plain
   * `Y.Doc`, so it rides the same yjs-relay path as markdown notes.
   *
   * The SVAR `<Kanban>` widget is a controlled component: it renders from the
   * `board` props and re-inits when they change (see its internal `$effect`).
   * We keep the Y.Doc as the single source of truth:
   *   - widget actions (add/update/move/delete/duplicate card, update column)
   *     fire the `on*` handlers, which reconcile the widget's authoritative
   *     state into the Y.Doc (tagged `KANBAN_LOCAL_ORIGIN`);
   *   - a `Y.Doc` observer rebuilds the `board` props on *remote* changes only
   *     (local writes are skipped via the origin tag), so peer edits flow in
   *     without clobbering in-flight local UI.
   *
   * See `$lib/kanban/kanban-yjs.ts` for the doc <-> board mapping.
   */

  import { onDestroy, onMount } from 'svelte';
  import * as Y from 'yjs';
  import { Awareness } from 'y-protocols/awareness';
  import { mode } from 'mode-watcher';
  import { Ellipsis, Pencil, Plus, Redo2, Trash2, Undo2 } from '@lucide/svelte';
  import {
    Kanban,
    Editor,
    ContextMenu as KanbanCardMenu,
    Willow,
    WillowDark,
    getEditorItems,
    getPriorityOptions
  } from '@svar-ui/svelte-kanban';
  import type { KanbanInstanceApi, CardShape } from '@svar-ui/svelte-kanban';
  import {
    loadNote,
    saveNote as apiSaveNote,
    TRASH_ID,
    noteRoomInfo,
    getYjsRelayUrl,
    onSessionChange,
    authSession,
    captureCurrentNoteVersion,
    type VersionAction
  } from '$lib/api';
  import { listen } from '$lib/api/events';
  import { tree } from '$lib/stores/tree.svelte';
  import { getSettingValue } from '$lib/settings/store.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { confirm } from '$lib/components/confirm-dialog.svelte';
  import AppContextMenu from '$lib/components/ContextMenu.svelte';
  import type { MenuItem } from '$lib/components/context-menu-types';
  import {
    Toolbar,
    ToolbarButton,
    ToolbarScrollbar,
    ToolbarSeparator
  } from '$lib/components/ui/toolbar';
  import { CollabProvider } from '$lib/sync/collab-provider';
  import { base64ToBytes } from '$lib/editor/base64';
  import { pickCursorColor } from '$lib/editor/cursor-color';
  import { resolveShareScopeUsers } from '$lib/notes/share-users';
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
  import TrashBanner from './note-editor/TrashBanner.svelte';
  import {
    KANBAN_LOCAL_ORIGIN,
    KANBAN_RESTORE_ORIGIN,
    boardToPlainText,
    createKanbanUndoManager,
    isLocalOnly,
    observeBoard,
    readBoardFromYDoc,
    removeCardFromYDoc,
    removeColumnFromYDoc,
    seedDefaultBoard,
    upsertBoardIntoYDoc,
    writeBoardToYDoc,
    type KanbanBoard,
    type KanbanCardData,
    type KanbanColumnData
  } from '$lib/kanban/kanban-yjs';

  interface Props {
    noteId: string;
  }
  let { noteId }: Props = $props();

  const SAVE_DEBOUNCE_MS = 800;
  const HISTORY_IDLE_DEFAULT_S = 180;
  /** Tag applied to updates merged in from a background sync — already on
   *  disk, so they must not re-trigger a save (would ping-pong with peers). */
  const REMOTE_SYNC_ORIGIN = Symbol('mindstream:kanban-sync-merge');

  let host = $state<HTMLDivElement | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let savingState = $state<'idle' | 'pending' | 'saving' | 'saved' | 'error'>(
    'idle'
  );

  let yDoc: Y.Doc | null = null;
  let awareness: Awareness | null = null;
  let undoManager: Y.UndoManager | null = null;
  let api = $state<KanbanInstanceApi | null>(null);
  let toolbarScrollEl = $state<HTMLDivElement | null>(null);
  /** Board props handed to the widget. Reassigned only on remote changes. */
  let board = $state<KanbanBoard>({ columns: [], cards: [] });

  let provider: CollabProvider | null = null;
  let stopObserve: (() => void) | null = null;
  let unsubSession: (() => void) | null = null;
  let unsubSync: (() => void) | null = null;
  let unregisterHistory: (() => void) | null = null;
  let editorListener: EditorListener | null = $state(null);

  let saveReady = false;
  let collabReady = false;
  let lastSeenPushed = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let historyTimer: ReturnType<typeof setTimeout> | null = null;
  let historyDirty = false;
  let interacted = false;
  let capturingHistory = false;
  let undoDepth = $state(0);
  let redoDepth = $state(0);

  // ---- Trash detection (mirrors NoteEditor / FreeformNoteEditor) ----
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

  const autoSaveEnabled = $derived(
    getSettingValue('editor.autoSave') !== false
  );
  const saveDebounceMs = $derived.by(() => {
    const v = Number(getSettingValue('editor.autoSaveDebounce'));
    return Number.isFinite(v) && v > 0 ? v : SAVE_DEBOUNCE_MS;
  });

  // ---- Card configuration (assignees + linked-note candidates) ----
  let userOptions = $state<{ id: string; label: string }[]>([]);
  const noteOptions = $derived(
    Object.values(tree.notesById)
      .filter((n) => n.id !== noteId && !n.trashed)
      .map((n) => ({
        id: n.id,
        label: n.title || tUi('editor.kanban.untitled')
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  );

  const cardShape = $derived<CardShape>({
    description: true,
    priority: { data: getPriorityOptions() },
    progress: true,
    deadline: true,
    users: userOptions.length > 0 ? { data: userOptions } : false
    // No `menu` button: the Edit/Duplicate/Delete menu opens on right-click
    // (see <KanbanCardMenu> + the board's oncontextmenu below).
  });

  // getEditorItems drives the card-detail form. Append a "linked note" field —
  // a wikilink-to-note attribute backed by the vault's note list.
  const editorItems = $derived([
    ...getEditorItems(cardShape),
    {
      comp: 'richselect',
      key: 'linkedNoteId',
      label: tUi('editor.kanban.linkedNote'),
      options: noteOptions,
      clear: true
    }
  ]);

  const ThemeComponent = $derived($mode === 'dark' ? WillowDark : Willow);
  const canUndo = $derived(undoDepth > 0);
  const canRedo = $derived(redoDepth > 0);

  function updateUndoState(): void {
    undoDepth = undoManager?.undoStack.length ?? 0;
    redoDepth = undoManager?.redoStack.length ?? 0;
  }

  // ---- Widget -> Y.Doc reconciliation ----
  function mapCard(
    c: Record<string, unknown>,
    column: string,
    order: number
  ): KanbanCardData {
    const rawDeadline = c.deadline;
    const deadline =
      rawDeadline instanceof Date
        ? rawDeadline
        : typeof rawDeadline === 'string'
          ? new Date(rawDeadline)
          : undefined;
    return {
      id: String(c.id),
      label: typeof c.label === 'string' ? c.label : '',
      column,
      description:
        typeof c.description === 'string' ? c.description : undefined,
      priority: typeof c.priority === 'number' ? c.priority : undefined,
      progress: typeof c.progress === 'number' ? c.progress : undefined,
      deadline:
        deadline && !Number.isNaN(deadline.getTime()) ? deadline : undefined,
      tags: Array.isArray(c.tags) ? c.tags.map(String) : undefined,
      users: Array.isArray(c.users) ? c.users.map(String) : undefined,
      linkedNoteId:
        typeof c.linkedNoteId === 'string' ? c.linkedNoteId : undefined,
      order
    };
  }

  /** Read the widget's authoritative state into a plain board. Order + column
   *  come from the rendered view; any card missing from the view (e.g. behind
   *  a future filter) is still included so reconcile never drops it. */
  function boardFromApi(): KanbanBoard {
    if (!api) return { columns: [], cards: [] };
    const state = api.getState();
    const columns = state.columns.map((c, i) => ({
      id: String(c.id),
      label: c.label,
      collapsed: c.collapsed || undefined,
      order: i
    }));
    const cards: KanbanCardData[] = [];
    const seen = new Set<string>();
    let order = 0;
    for (const col of state.viewData.columns) {
      for (const c of col.cards) {
        const id = String(c.id);
        if (seen.has(id)) continue;
        seen.add(id);
        cards.push(mapCard(c, String(col.id), order++));
      }
    }
    for (const c of api.getCards()) {
      const id = String(c.id);
      if (seen.has(id)) continue;
      seen.add(id);
      cards.push(mapCard(c, String(c.column ?? ''), order++));
    }
    return { columns, cards };
  }

  // Push the widget's current cards/columns into the doc *additively* — this
  // never deletes, so a transient or stale widget snapshot can't drop a card.
  // Runs synchronously inside the action handler (the store has already applied
  // the action by the time our `on` handler fires), so the local edit is in the
  // doc before any remote merge can rebuild the widget from it — closing the
  // race that would otherwise wipe an in-flight edit.
  function syncFromWidget(): void {
    if (!yDoc || !api || isTrashed) return;
    upsertBoardIntoYDoc(yDoc, boardFromApi(), KANBAN_LOCAL_ORIGIN);
    updateUndoState();
  }

  /** Additive edits keep every card; only an explicit delete removes one. */
  const UPSERT_ACTIONS = [
    'add-card',
    'update-card',
    'move-card',
    'duplicate-card',
    'update-column'
  ] as const;

  function handleInit(kanbanApi: KanbanInstanceApi): void {
    api = kanbanApi;
    // SVAR's card editor saves via `update-card` with the FULL card snapshot it
    // captured when the editor opened (`card: { ...ev.values }`). If the card
    // was dragged to another column/position while the editor stayed open, that
    // snapshot carries the stale `column`/`order`, and the patch would move the
    // card back. Position only ever changes through `move-card`, so strip those
    // fields from every `update-card` patch.
    kanbanApi.intercept('update-card', (ev: unknown) => {
      const card = (ev as { card?: Record<string, unknown> } | undefined)?.card;
      if (card) {
        delete card.column;
        delete card.order;
      }
      return true;
    });
    for (const action of UPSERT_ACTIONS) {
      kanbanApi.on(action, () => syncFromWidget());
    }
    // Deletion is the one path that removes a card from the doc. Use the action
    // payload's id (not a state diff) so it's exact regardless of timing.
    kanbanApi.on('delete-card', (ev: unknown) => {
      if (!yDoc || isTrashed) return;
      const id = (ev as { id?: string | number | null } | undefined)?.id;
      if (id != null) removeCardFromYDoc(yDoc, String(id), KANBAN_LOCAL_ORIGIN);
      syncFromWidget();
    });
  }

  // ---- Column (list) management ----
  // SVAR exposes only update-column (rename/collapse), no add/remove. These
  // write straight to the Yjs columns array and then rebuild the widget props
  // (a deliberate structural change, so re-init churn is fine). Column edits
  // upsert additively; a column leaves the doc only via removeColumnFromYDoc.
  // Right-click card menu (SVAR ContextMenu instance) + list ⋯ menu / inline
  // rename state. `listMenu` holds the open list's id and the cursor anchor for
  // the app context menu; `renamingListId` is the list currently showing an
  // inline rename input.
  let cardMenu = $state<{
    show: (ev: Event, id: string | number) => void;
  } | null>(null);
  let listMenu = $state<{ id: string; x: number; y: number } | null>(null);
  let renamingListId = $state<string | null>(null);
  let draggingListId = $state<string | null>(null);
  let listDropTarget = $state<{
    id: string;
    position: 'before' | 'after';
  } | null>(null);

  function addColumn(): void {
    if (!yDoc || isTrashed) return;
    const maxOrder = board.columns.reduce((m, c) => Math.max(m, c.order), -1);
    const column: KanbanColumnData = {
      id: crypto.randomUUID(),
      label: tUi('editor.kanban.newList'),
      order: maxOrder + 1
    };
    upsertBoardIntoYDoc(yDoc, { columns: [column], cards: [] });
    board = readBoardFromYDoc(yDoc);
    updateUndoState();
    // Drop straight into inline rename so the user can name it immediately.
    renamingListId = column.id;
  }

  function openListMenu(e: MouseEvent, id: string): void {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    listMenu = { id, x: rect.left, y: rect.bottom + 4 };
  }

  function openCardMenu(e: MouseEvent): void {
    if (!cardMenu || isTrashed) return;
    const target = e.target instanceof Element ? e.target : null;
    const cardEl = target?.closest<HTMLElement>('.wx-card[data-id]');
    const id = cardEl?.dataset.id;
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    cardMenu.show(e, id);
  }

  function handleToolbarWheel(event: WheelEvent): void {
    const el = event.currentTarget as HTMLElement;
    if (el.scrollWidth <= el.clientWidth) return;
    const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
    if (delta === 0) return;
    el.scrollLeft += delta;
    event.preventDefault();
  }

  function undoKanbanAction(): void {
    if (!undoManager || isTrashed || !canUndo) return;
    undoManager.undo();
    if (yDoc) board = readBoardFromYDoc(yDoc);
    updateUndoState();
  }

  function redoKanbanAction(): void {
    if (!undoManager || isTrashed || !canRedo) return;
    undoManager.redo();
    if (yDoc) board = readBoardFromYDoc(yDoc);
    updateUndoState();
  }

  const listMenuItems = $derived<(MenuItem | 'separator')[]>(
    listMenu
      ? [
          {
            label: tUi('editor.kanban.renameList'),
            icon: Pencil,
            onSelect: () => startRenameList(listMenu!.id)
          },
          {
            label: tUi('editor.kanban.deleteList'),
            icon: Trash2,
            destructive: true,
            disabled: board.columns.length <= 1,
            onSelect: () => void removeColumn(listMenu!.id)
          }
        ]
      : []
  );

  function startRenameList(id: string): void {
    listMenu = null;
    renamingListId = id;
  }

  function commitRenameList(id: string, value: string): void {
    if (renamingListId === id) renamingListId = null;
    renameColumn(id, value);
  }

  function cancelRenameList(): void {
    renamingListId = null;
  }

  // Autofocus + select the rename input when it appears (mirrors note rename).
  function focusRenameInput(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function renameColumn(id: string, label: string): void {
    if (!yDoc || isTrashed) return;
    const existing = board.columns.find((c) => c.id === id);
    if (!existing) return;
    const next = label.trim() || existing.label;
    if (next === existing.label) return;
    upsertBoardIntoYDoc(yDoc, {
      columns: [{ ...existing, label: next }],
      cards: []
    });
    board = readBoardFromYDoc(yDoc);
    updateUndoState();
  }

  function startListDrag(event: DragEvent, id: string): void {
    if (renamingListId === id) {
      event.preventDefault();
      return;
    }
    draggingListId = id;
    listDropTarget = null;
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  function dragListOver(event: DragEvent, id: string): void {
    const sourceId =
      draggingListId ?? event.dataTransfer?.getData('text/plain');
    if (!sourceId || sourceId === id) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    listDropTarget = {
      id,
      position: event.clientX > rect.left + rect.width / 2 ? 'after' : 'before'
    };
  }

  function dropList(event: DragEvent, id: string): void {
    event.preventDefault();
    const sourceId =
      draggingListId ?? event.dataTransfer?.getData('text/plain');
    const position =
      listDropTarget?.id === id ? listDropTarget.position : 'before';
    if (sourceId && sourceId !== id) reorderColumn(sourceId, id, position);
    endListDrag();
  }

  function endListDrag(): void {
    draggingListId = null;
    listDropTarget = null;
  }

  function reorderColumn(
    sourceId: string,
    targetId: string,
    position: 'before' | 'after'
  ): void {
    if (!yDoc || isTrashed) return;
    const columns = [...board.columns];
    const sourceIndex = columns.findIndex((c) => c.id === sourceId);
    const targetIndex = columns.findIndex((c) => c.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;

    const [moved] = columns.splice(sourceIndex, 1);
    let insertIndex = targetIndex;
    if (sourceIndex < targetIndex) insertIndex -= 1;
    if (position === 'after') insertIndex += 1;
    columns.splice(
      Math.max(0, Math.min(insertIndex, columns.length)),
      0,
      moved
    );

    upsertBoardIntoYDoc(yDoc, {
      columns: columns.map((col, order) => ({ ...col, order })),
      cards: []
    });
    board = readBoardFromYDoc(yDoc);
    updateUndoState();
  }

  async function removeColumn(id: string): Promise<void> {
    if (!yDoc || isTrashed) return;
    const column = board.columns.find((c) => c.id === id);
    if (!column) return;
    if (board.columns.length <= 1) return; // keep at least one list
    const cardCount = board.cards.filter((c) => c.column === id).length;
    if (cardCount > 0) {
      const ok = await confirm({
        title: tUi('editor.kanban.deleteListTitle'),
        message: tUi('editor.kanban.deleteListBody')
          .replace('{list}', column.label)
          .replace('{count}', String(cardCount)),
        confirmLabel: tUi('editor.kanban.deleteListConfirm'),
        cancelLabel: tUi('editor.kanban.deleteListCancel'),
        destructive: true
      });
      if (!ok || !yDoc) return;
    }
    removeColumnFromYDoc(yDoc, id, true);
    board = readBoardFromYDoc(yDoc);
    updateUndoState();
  }

  // ---- Save ----
  function scheduleSave(): void {
    if (isTrashed) return;
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
    saveTimer = setTimeout(() => {
      void persist();
    }, saveDebounceMs);
  }

  async function persist(): Promise<void> {
    if (!yDoc || isTrashed) return;
    try {
      savingState = 'saving';
      const snapshot = readBoardFromYDoc(yDoc);
      // Array.from: Tauri serialises a bare Uint8Array as `{}` over the IPC
      // boundary, so hand Rust a plain number[].
      const yrsState = Array.from(Y.encodeStateAsUpdate(yDoc));
      await apiSaveNote({
        id: noteId,
        // Plaintext projection so full-text search / content-stats index cards.
        body: boardToPlainText(snapshot),
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
      console.error('[KanbanNoteEditor] save failed', err);
    }
  }

  // ---- History ----
  function currentSnapshot(): string {
    if (!yDoc) return serializeYjsSnapshot('kanban', new Uint8Array());
    return serializeYjsSnapshot('kanban', Y.encodeStateAsUpdate(yDoc));
  }

  function restoreSnapshot(body: string): void {
    if (!yDoc) return;
    const parsed = parseHistorySnapshot(body, 'kanban');
    if (parsed.noteKind !== 'kanban') return;
    const snapshotDoc = new Y.Doc();
    if (parsed.bytes.byteLength > 0) Y.applyUpdate(snapshotDoc, parsed.bytes);
    try {
      capturingHistory = true;
      writeBoardToYDoc(
        yDoc,
        readBoardFromYDoc(snapshotDoc),
        KANBAN_RESTORE_ORIGIN
      );
      board = readBoardFromYDoc(yDoc);
    } finally {
      capturingHistory = false;
      snapshotDoc.destroy();
    }
  }

  function historyIdleMs(): number {
    const v = Number(getSettingValue('data.historyIdleSeconds'));
    return (Number.isFinite(v) && v > 0 ? v : HISTORY_IDLE_DEFAULT_S) * 1000;
  }

  function scheduleHistoryCapture(): void {
    if (isTrashed) return;
    historyDirty = true;
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = setTimeout(() => {
      historyTimer = null;
      void captureHistoryVersion('edited');
    }, historyIdleMs());
  }

  async function captureHistoryVersion(action: VersionAction): Promise<void> {
    if (!yDoc) return;
    if (action === 'edited' && !historyDirty) return;
    historyDirty = false;
    try {
      const created = await captureCurrentNoteVersion(noteId, action);
      if (created) bumpNoteHistory(noteId);
    } catch (err) {
      console.debug('[KanbanNoteEditor] history capture failed', err);
    }
  }

  // ---- Collab provider (yjs-relay, same as markdown notes) ----
  async function setupCollabProvider(): Promise<void> {
    if (provider) {
      provider.destroy();
      provider = null;
    }
    const collabUrl = getYjsRelayUrl(
      (getSettingValue('account.serverUrl') as string | undefined) ?? ''
    );
    if (!collabUrl || !yDoc || !awareness) return;
    try {
      const room = await noteRoomInfo(noteId);
      if (!room) return;
      provider = new CollabProvider({
        url: collabUrl,
        roomId: room.room_id,
        keyBytes: base64ToBytes(room.key_b64),
        doc: yDoc,
        awareness
      });
    } catch (err) {
      console.debug('[KanbanNoteEditor] collab provider init failed', err);
    }
  }

  onMount(async () => {
    if (!host) return;
    try {
      const note = await loadNote(noteId);
      if (!host) return; // unmounted while awaiting

      const localYDoc = new Y.Doc();
      yDoc = localYDoc;
      if (note.yrs_state.length > 0) {
        try {
          Y.applyUpdate(localYDoc, new Uint8Array(note.yrs_state));
        } catch (err) {
          console.warn('[KanbanNoteEditor] yrs_state hydration failed', err);
        }
      }
      // A brand-new board (never edited) has no columns yet — seed the default
      // three so the user lands on a usable board. No-op for existing boards.
      seedDefaultBoard(localYDoc);
      board = readBoardFromYDoc(localYDoc);
      undoManager = createKanbanUndoManager(localYDoc);
      updateUndoState();

      const localAwareness = new Awareness(localYDoc);
      awareness = localAwareness;
      const userName = authSession.current?.username ?? null;
      if (userName) {
        localAwareness.setLocalStateField('user', {
          name: userName,
          color: pickCursorColor(userName)
        });
      }

      // Every mutation — local reconcile writes, collab-applied peer ops, or a
      // sync merge — lands as a `Y.Doc` 'update'. One hook drives the debounced
      // save; sync-merge updates skip it (already persisted).
      localYDoc.on('update', (_update: Uint8Array, origin: unknown) => {
        if (!saveReady) return;
        if (origin === REMOTE_SYNC_ORIGIN) return;
        scheduleSave();
        if (!capturingHistory && interacted) scheduleHistoryCapture();
      });
      saveReady = true;

      // Rebuild the widget props only when a remote/peer change touches the
      // doc; local reconciles carry KANBAN_LOCAL_ORIGIN and are ignored so the
      // widget keeps its own optimistic state mid-interaction.
      stopObserve = observeBoard(localYDoc, (events) => {
        if (isLocalOnly(events)) return;
        board = readBoardFromYDoc(localYDoc);
      });

      lastSeenPushed = tree.notesById[noteId]?.pushed ?? false;
      await setupCollabProvider();
      collabReady = true;
      unsubSession = onSessionChange(() => {
        void setupCollabProvider();
      });

      // Merge freshly-synced state into the live doc (CRDT-safe). Tagged so the
      // update handler doesn't re-save what just came off disk.
      void listen('sync-completed', async (payload) => {
        if (!payload.notes_pulled_ids.includes(noteId) || !yDoc) return;
        try {
          const fresh = await loadNote(noteId);
          if (yDoc && fresh.yrs_state.length > 0) {
            Y.applyUpdate(
              yDoc,
              new Uint8Array(fresh.yrs_state),
              REMOTE_SYNC_ORIGIN
            );
          }
        } catch (err) {
          console.warn('[KanbanNoteEditor] sync-completed merge failed', err);
        }
      }).then((unlisten) => {
        unsubSync = unlisten;
      });

      // Command-bus listener: no kanban commands in the catalogue yet, but
      // installing it displaces any markdown listener so editor hotkeys don't
      // leak into a hidden markdown note (same rationale as FreeformNoteEditor).
      editorListener = {
        kind: 'kanban',
        host,
        onCommand: () => false
      };
      registerEditor(editorListener);

      unregisterHistory = registerNoteHistory(noteId, {
        currentSnapshot: () => currentSnapshot(),
        restoreSnapshot: (snapshot) => restoreSnapshot(snapshot),
        snapshotNow: () => captureHistoryVersion('edited')
      });

      loading = false;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      loading = false;
      console.error('[KanbanNoteEditor] load failed', err);
    }
  });

  // Re-promote this editor on focus so the most recently focused note wins the
  // command bus (mirrors NoteEditor / FreeformNoteEditor).
  $effect(() => {
    if (!host || !editorListener) return;
    const listener = editorListener;
    const el = host;
    const onFocusIn = () => registerEditor(listener);
    const onInteract = () => {
      interacted = true;
    };
    el.addEventListener('focusin', onFocusIn);
    el.addEventListener('pointerdown', onInteract, true);
    el.addEventListener('keydown', onInteract, true);
    return () => {
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('pointerdown', onInteract, true);
      el.removeEventListener('keydown', onInteract, true);
    };
  });

  // Re-attach live collab the moment a freshly-created note completes its first
  // push (room key only resolves post-push).
  $effect(() => {
    const pushed = tree.notesById[noteId]?.pushed ?? false;
    if (!collabReady) return;
    if (pushed === lastSeenPushed) return;
    lastSeenPushed = pushed;
    void setupCollabProvider();
  });

  // Resolve assignee candidates from the note's share scope.
  $effect(() => {
    const me = authSession.current?.username ?? null;
    const note = tree.notesById[noteId];
    let cancelled = false;
    void resolveShareScopeUsers(
      note?.parent_collection_id ?? null,
      tree.collectionsById,
      me
    ).then((users) => {
      if (cancelled) return;
      userOptions = users.map((u) => ({ id: u.username, label: u.username }));
    });
    return () => {
      cancelled = true;
    };
  });

  onDestroy(() => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (historyTimer) {
      clearTimeout(historyTimer);
      historyTimer = null;
    }
    // Flush a pending save synchronously-ish before teardown.
    if (saveReady && !isTrashed) void persist();
    stopObserve?.();
    unsubSession?.();
    unsubSync?.();
    unregisterHistory?.();
    if (editorListener) unregisterEditor(editorListener);
    provider?.destroy();
    provider = null;
    awareness?.destroy();
    awareness = null;
    undoManager?.destroy();
    undoManager = null;
    yDoc?.destroy();
    yDoc = null;
  });
</script>

<div class="flex h-full flex-col" bind:this={host}>
  {#if loadError}
    <div
      class="flex h-full items-center justify-center p-6 text-sm text-destructive"
    >
      {loadError}
    </div>
  {:else if loading}
    <div
      class="flex h-full items-center justify-center p-6 text-sm text-muted-foreground"
    >
      {tUi('editor.kanban.loading')}
    </div>
  {:else}
    {#if isTrashed}
      <TrashBanner />
    {/if}
    <div class="relative min-h-0 flex-1">
      <ThemeComponent>
        <div class="kanban-scope flex flex-col">
          {#if !isTrashed}
            <div class="kanban-toolbar-shell">
              <Toolbar
                bind:ref={toolbarScrollEl}
                dense
                aria-label={tUi('editor.kanban.toolbar')}
                class="scrollbar-none overflow-x-auto"
                onwheel={handleToolbarWheel}
              >
                <ToolbarButton
                  onclick={undoKanbanAction}
                  disabled={!canUndo}
                  aria-label={tUi('editor.toolbar.undo')}
                  title={tUi('editor.toolbar.undo')}
                >
                  <Undo2 aria-hidden="true" />
                </ToolbarButton>

                <ToolbarButton
                  onclick={redoKanbanAction}
                  disabled={!canRedo}
                  aria-label={tUi('editor.toolbar.redo')}
                  title={tUi('editor.toolbar.redo')}
                >
                  <Redo2 aria-hidden="true" />
                </ToolbarButton>

                <ToolbarSeparator />

                {#each board.columns as col (col.id)}
                  <div
                    class="kanban-list-chip"
                    class:kanban-list-chip-dragging={draggingListId === col.id}
                    class:kanban-list-chip-drop-before={listDropTarget?.id ===
                      col.id && listDropTarget.position === 'before'}
                    class:kanban-list-chip-drop-after={listDropTarget?.id ===
                      col.id && listDropTarget.position === 'after'}
                    role="group"
                    aria-label={col.label}
                    draggable={renamingListId !== col.id}
                    aria-grabbed={draggingListId === col.id}
                    ondragstart={(event) => startListDrag(event, col.id)}
                    ondragover={(event) => dragListOver(event, col.id)}
                    ondragleave={() => {
                      if (listDropTarget?.id === col.id) listDropTarget = null;
                    }}
                    ondrop={(event) => dropList(event, col.id)}
                    ondragend={endListDrag}
                  >
                    {#if renamingListId === col.id}
                      <input
                        class="kanban-list-name"
                        value={col.label}
                        aria-label={tUi('editor.kanban.renameList')}
                        use:focusRenameInput
                        onblur={(e) =>
                          commitRenameList(col.id, e.currentTarget.value)}
                        onkeydown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur();
                          else if (e.key === 'Escape') cancelRenameList();
                        }}
                      />
                    {:else}
                      <span class="kanban-list-label" title={col.label}
                        >{col.label}</span
                      >
                      <ToolbarButton
                        class="size-8"
                        aria-label={tUi('editor.kanban.listMenu')}
                        title={tUi('editor.kanban.listMenu')}
                        onclick={(e) => openListMenu(e, col.id)}
                      >
                        <Ellipsis aria-hidden="true" />
                      </ToolbarButton>
                    {/if}
                  </div>
                {/each}
                <ToolbarButton
                  aria-label={tUi('editor.kanban.addList')}
                  title={tUi('editor.kanban.addList')}
                  onclick={addColumn}
                >
                  <Plus aria-hidden="true" />
                </ToolbarButton>
              </Toolbar>
              <ToolbarScrollbar target={toolbarScrollEl} />
            </div>
          {/if}
          <!-- Right-click a card to open the Edit/Duplicate/Delete menu. -->
          <div
            class="relative min-h-0 flex-1"
            role="presentation"
            oncontextmenu={openCardMenu}
          >
            <Kanban
              cards={board.cards}
              columns={board.columns}
              card={cardShape}
              readonly={isTrashed}
              init={handleInit}
            />
            {#if api && !isTrashed}
              <Editor {api} items={editorItems} />
            {/if}
          </div>
          <KanbanCardMenu {api} bind:this={cardMenu} />
        </div>
      </ThemeComponent>
    </div>
    {#if listMenu}
      <AppContextMenu
        x={listMenu.x}
        y={listMenu.y}
        items={listMenuItems}
        onClose={() => (listMenu = null)}
      />
    {/if}
  {/if}
</div>

<style>
  /* Re-skin the SVAR widget with the app's design tokens so the board matches
     the rest of the UI in both light and dark. The app tokens (--card,
     --muted, …) already switch with the theme, so a single set of overrides
     covers both modes. Set on an inner wrapper (a closer ancestor than SVAR's
     .wx-*-theme div) so these win regardless of stylesheet order. Several
     kanban vars are hardcoded hex in the SVAR theme, so they're listed
     explicitly rather than relying on the base-var derivations. */
  .kanban-scope {
    height: 100%;
    width: 100%;

    /* base palette */
    --wx-background: var(--card);
    --wx-background-alt: var(--muted);
    --wx-background-hover: var(--accent);
    --wx-border-color: var(--border);
    --wx-color-font: var(--foreground);
    --wx-color-font-alt: var(--muted-foreground);
    --wx-color-primary: var(--primary);
    --wx-color-link: var(--primary);

    /* kanban surfaces (hardcoded in the SVAR theme — override directly) */
    --wx-kanban-bg: var(--background);
    --wx-kanban-column-bg: var(--muted);
    --wx-kanban-card-bg: var(--card);
    --wx-kanban-tag-bg: var(--accent);
    --wx-kanban-avatar-bg: var(--muted);
    --wx-kanban-border-color: var(--border);
    --wx-kanban-progress-bg: var(--muted);
    --wx-kanban-progress-fill: var(--primary);
    --wx-kanban-card-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
  }

  /* List-management toolbar (add / rename / remove columns). */
  .kanban-toolbar-shell {
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
    background: var(--background);
  }
  .kanban-list-chip {
    position: relative;
    display: inline-flex;
    height: 2.25rem;
    flex-shrink: 0;
    align-items: center;
    gap: 0.25rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--card);
    padding-left: 0.5rem;
    padding-right: 0.125rem;
    cursor: grab;
    transition:
      border-color 120ms,
      box-shadow 120ms,
      opacity 120ms;
  }
  .kanban-list-chip:active {
    cursor: grabbing;
  }
  .kanban-list-chip:focus-within {
    border-color: var(--ring);
    box-shadow: 0 0 0 1px var(--ring);
  }
  .kanban-list-chip-dragging {
    opacity: 0.55;
  }
  .kanban-list-chip-drop-before {
    box-shadow: -3px 0 0 var(--ring);
  }
  .kanban-list-chip-drop-after {
    box-shadow: 3px 0 0 var(--ring);
  }
  .kanban-list-label {
    max-width: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.75rem;
    color: var(--foreground);
  }
  .kanban-list-name {
    width: 9rem;
    min-width: 4rem;
    max-width: 12rem;
    height: 1.75rem;
    border: 1px solid transparent;
    background: transparent;
    padding: 0 0.375rem;
    font-size: 0.75rem;
    color: var(--foreground);
    border-radius: 0.375rem;
  }
  .kanban-list-name:focus {
    outline: none;
  }
  /* Match the app's thin themed scrollbars on the SVAR scroll containers
     (see .themed-scrollbar in app.css) instead of the thick OS default. */
  :global(.kanban-scope .wx-board),
  :global(.kanban-scope .wx-scroll-board),
  :global(.kanban-scope .wx-column-cards),
  :global(.kanban-scope .wx-scroll) {
    scrollbar-width: thin;
    scrollbar-color: oklch(from var(--foreground) l c h / 0.3) transparent;
  }
  :global(.kanban-scope .wx-board)::-webkit-scrollbar,
  :global(.kanban-scope .wx-scroll-board)::-webkit-scrollbar,
  :global(.kanban-scope .wx-column-cards)::-webkit-scrollbar,
  :global(.kanban-scope .wx-scroll)::-webkit-scrollbar {
    width: 12px;
    height: 12px;
  }
  :global(.kanban-scope .wx-board)::-webkit-scrollbar-track,
  :global(.kanban-scope .wx-scroll-board)::-webkit-scrollbar-track,
  :global(.kanban-scope .wx-column-cards)::-webkit-scrollbar-track,
  :global(.kanban-scope .wx-scroll)::-webkit-scrollbar-track {
    background: transparent;
  }
  :global(.kanban-scope .wx-board)::-webkit-scrollbar-thumb,
  :global(.kanban-scope .wx-scroll-board)::-webkit-scrollbar-thumb,
  :global(.kanban-scope .wx-column-cards)::-webkit-scrollbar-thumb,
  :global(.kanban-scope .wx-scroll)::-webkit-scrollbar-thumb {
    background: oklch(from var(--foreground) l c h / 0.22);
    background-clip: content-box;
    border: 3px solid transparent;
    border-radius: 8px;
    transition: background-color 120ms;
  }
  :global(.kanban-scope .wx-board)::-webkit-scrollbar-thumb:hover,
  :global(.kanban-scope .wx-scroll-board)::-webkit-scrollbar-thumb:hover,
  :global(.kanban-scope .wx-column-cards)::-webkit-scrollbar-thumb:hover,
  :global(.kanban-scope .wx-scroll)::-webkit-scrollbar-thumb:hover {
    background: oklch(from var(--foreground) l c h / 0.45);
    background-clip: content-box;
  }
</style>
