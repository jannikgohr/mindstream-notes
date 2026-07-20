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
    getPriorityOptions,
    registerEditorItem
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
  import {
    horizontalInsertionIndex,
    moveItemToIndex
  } from '$lib/actions/horizontal-reorder';
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
  import { collabCredentialsChangedForNote } from '$lib/sync/collab-credentials';
  import {
    collabAuthForRoom,
    getOrCreateCollabSigningMaterial
  } from '$lib/sync/collab-signing-key';
  import { base64ToBytes } from '$lib/editor/base64';
  import { pickCursorColor } from '$lib/editor/cursor-color';
  import { folderPathLabel } from '$lib/notes/folder-path';
  import { resolveShareScopeUsers } from '$lib/notes/share-users';
  import {
    registerEditor,
    SEARCH_ACTIVE_NOTE_COMMAND,
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
  import KanbanCardContent from './kanban/KanbanCardContent.svelte';
  import KanbanLabelsField, {
    type KanbanLabelOption
  } from './kanban/KanbanLabelsField.svelte';
  import KanbanLinkedNoteField, {
    type KanbanNoteOption
  } from './kanban/KanbanLinkedNoteField.svelte';
  import KanbanSearchPanel from './kanban/KanbanSearchPanel.svelte';
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
    removeLabelFromYDoc,
    seedDefaultBoard,
    upsertBoardIntoYDoc,
    writeBoardToYDoc,
    type KanbanBoard,
    type KanbanCardData,
    type KanbanColumnData,
    type KanbanLabelData
  } from '$lib/kanban/kanban-yjs';
  import {
    EMPTY_KANBAN_SEARCH_FILTERS,
    KANBAN_SEARCH_FILTER_TAG,
    applyKanbanSearchFilter,
    matchesKanbanSearchFilters,
    type KanbanSearchFilters,
    type KanbanSearchLookups
  } from '$lib/kanban/kanban-search';

  registerEditorItem('mindstream-linked-note', KanbanLinkedNoteField);
  registerEditorItem('mindstream-labels', KanbanLabelsField);

  interface Props {
    noteId: string;
  }
  interface ListPointerDrag {
    id: string;
    pointerId: number;
    grabX: number;
    width: number;
    height: number;
    top: number;
    x: number;
    sourceIndex: number;
  }
  let { noteId }: Props = $props();

  const SAVE_DEBOUNCE_MS = 800;
  const HISTORY_IDLE_DEFAULT_S = 180;
  const LABEL_COLORS = [
    '#3b82f6',
    '#22c55e',
    '#f59e0b',
    '#ef4444',
    '#8b5cf6',
    '#06b6d4',
    '#ec4899',
    '#64748b'
  ];
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
  let searchPanel = $state<{ focus: () => void } | null>(null);
  /** Board props handed to the widget. Reassigned only on remote changes. */
  let board = $state<KanbanBoard>({ columns: [], cards: [] });

  let provider: CollabProvider | null = null;
  let stopObserve: (() => void) | null = null;
  let unsubSession: (() => void) | null = null;
  let unsubSync: (() => void) | null = null;
  let unsubCollabCredentials: (() => void) | null = null;
  let unregisterHistory: (() => void) | null = null;
  let editorListener: EditorListener | null = $state(null);

  let saveReady = false;
  let collabReady = false;
  let lastSeenPushed = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let historyTimer: ReturnType<typeof setTimeout> | null = null;
  let historyDirty = false;
  let capturingHistory = false;
  let undoDepth = $state(0);
  let redoDepth = $state(0);
  let searchOpen = $state(false);
  let searchFilters = $state<KanbanSearchFilters>({
    ...EMPTY_KANBAN_SEARCH_FILTERS
  });

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

  // ---- Card configuration (assignees + linked-note candidates + labels) ----
  let userOptions = $state<{ id: string; label: string }[]>([]);
  const noteOptions = $derived.by<KanbanNoteOption[]>(() => {
    const all = Object.values(tree.notesById).filter(
      (n) => n.id !== noteId && !n.trashed
    );
    const titleCounts = new Map<string, number>();
    for (const n of all) {
      const key = (n.title || tUi('editor.kanban.untitled'))
        .trim()
        .toLowerCase();
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }
    return all
      .map((n) => {
        const label = n.title || tUi('editor.kanban.untitled');
        const key = label.trim().toLowerCase();
        return {
          id: n.id,
          label,
          note_kind: n.note_kind,
          path: folderPathLabel(n.parent_collection_id, tree.collectionsById),
          modified: n.modified,
          duplicateTitle: (titleCounts.get(key) ?? 0) > 1
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  });

  const labelOptions = $derived.by<KanbanLabelOption[]>(() => {
    const labels = new Map<string, KanbanLabelOption>();
    const usedLabelIds = new Set<string>();
    for (const card of board.cards) {
      for (const id of card.tags ?? []) usedLabelIds.add(id);
    }
    for (const label of board.labels ?? []) {
      labels.set(label.id, {
        id: label.id,
        label: label.label,
        color: label.color,
        unused: !usedLabelIds.has(label.id)
      });
    }
    for (const card of board.cards) {
      for (const id of card.tags ?? []) {
        if (!labels.has(id)) labels.set(id, { id, label: id });
      }
    }
    return [...labels.values()].sort((a, b) => a.label.localeCompare(b.label));
  });

  const cardShape = $derived<CardShape>({
    description: true,
    priority: { data: getPriorityOptions() },
    progress: true,
    deadline: true,
    tags: labelOptions.length > 0 ? { data: labelOptions, max: 4 } : true,
    users: userOptions.length > 0 ? { data: userOptions } : false
    // No `menu` button: the Edit/Duplicate/Delete menu opens on right-click
    // (see <KanbanCardMenu> + the board's oncontextmenu below).
  });

  // getEditorItems drives the card-detail form. Append a "linked note" field —
  // a wikilink-to-note attribute backed by the vault's note list.
  const editorItems = $derived([
    ...getEditorItems(cardShape).filter((item) => item.key !== 'tags'),
    {
      comp: 'mindstream-labels',
      key: 'tags',
      label: tUi('editor.kanban.labels'),
      options: labelOptions,
      oncreate: createLabel,
      ondelete: deleteUnusedLabel
    },
    {
      comp: 'mindstream-linked-note',
      key: 'linkedNoteId',
      label: tUi('editor.kanban.linkedNote'),
      options: noteOptions,
      clear: true
    }
  ]);

  const ThemeComponent = $derived($mode === 'dark' ? WillowDark : Willow);
  const canUndo = $derived(undoDepth > 0);
  const canRedo = $derived(redoDepth > 0);
  const priorityOptions = $derived(
    getPriorityOptions().map((option) => ({
      id: Number(option.id),
      label: String(option.label)
    }))
  );
  const searchLookups = $derived<KanbanSearchLookups>({
    columns: board.columns,
    labels: board.labels ?? [],
    notes: noteOptions.map((note) => ({
      id: note.id,
      label: note.label,
      path: note.path
    })),
    priorities: priorityOptions
  });
  const searchMatchCount = $derived.by(
    () =>
      board.cards.filter((card) =>
        matchesKanbanSearchFilters(card, searchFilters, searchLookups)
      ).length
  );

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

  $effect(() => {
    if (!api) return;
    applyKanbanSearchFilter(api, searchFilters, searchLookups);
  });

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
  // Not reactive: read once per click to decide whether the press that produced
  // it originated inside the card editor.
  let pressStartedInsideCardEditor = false;
  let renamingListId = $state<string | null>(null);
  let listDrag = $state<ListPointerDrag | null>(null);
  let listDropIndex = $state<number | null>(null);
  let listDragMoved = $state(false);
  const displayedColumns = $derived.by(() => {
    if (!listDrag) return board.columns;
    return moveItemToIndex(
      board.columns,
      listDrag.id,
      listDropIndex ?? listDrag.sourceIndex
    );
  });
  const draggedColumn = $derived.by(() => {
    const drag = listDrag;
    return drag ? board.columns.find((col) => col.id === drag.id) : null;
  });

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
    const cardEl = target?.closest<HTMLElement>(
      '.wx-card[data-id], .wx-card-row[data-kanban-card-id]'
    );
    const id = cardEl?.dataset.id ?? cardEl?.dataset.kanbanCardId;
    if (!id) return;
    cardMenu.show(e, id);
    e.preventDefault();
    e.stopPropagation();
  }

  const CARD_EDITOR_KEEP_OPEN_SELECTOR =
    '.wx-card[data-id], .wx-card-row[data-kanban-card-id], .kanban-card-editor';

  function startsInsideCardEditor(target: EventTarget | null): boolean {
    return (
      target instanceof Element &&
      target.closest(CARD_EDITOR_KEEP_OPEN_SELECTOR) !== null
    );
  }

  // A drag that starts in the editor (selecting text) and ends on the board
  // fires a click whose target is the common ancestor — i.e. the board. Remember
  // where the press started so such a release doesn't close the editor.
  function rememberCardEditorPressOrigin(e: PointerEvent): void {
    pressStartedInsideCardEditor = startsInsideCardEditor(e.target);
  }

  function closeCardEditorOnBoardClick(e: MouseEvent): void {
    const startedInside = pressStartedInsideCardEditor;
    pressStartedInsideCardEditor = false;
    if (!api || isTrashed || e.button !== 0) return;
    if (startedInside || startsInsideCardEditor(e.target)) return;
    api.exec('select-card', { id: null });
  }

  function openKanbanSearch(): void {
    if (isTrashed) return;
    searchOpen = true;
    queueMicrotask(() => searchPanel?.focus());
  }

  function closeKanbanSearch(): void {
    searchOpen = false;
    searchFilters = { ...EMPTY_KANBAN_SEARCH_FILTERS };
    api?.exec('filter-cards', { tag: KANBAN_SEARCH_FILTER_TAG });
  }

  function updateKanbanSearch(filters: KanbanSearchFilters): void {
    searchFilters = filters;
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

  function createLabel(label: string): KanbanLabelOption | null {
    if (!yDoc || isTrashed) return null;
    const trimmed = label.trim();
    if (!trimmed) return null;
    const existing = (board.labels ?? []).find(
      (item) => item.label.trim().toLowerCase() === trimmed.toLowerCase()
    );
    if (existing) {
      return {
        id: existing.id,
        label: existing.label,
        color: existing.color
      };
    }
    const labels = board.labels ?? [];
    const next: KanbanLabelData = {
      id: crypto.randomUUID(),
      label: trimmed,
      color: LABEL_COLORS[labels.length % LABEL_COLORS.length],
      order: labels.reduce((max, item) => Math.max(max, item.order), -1) + 1
    };
    upsertBoardIntoYDoc(yDoc, { columns: [], cards: [], labels: [next] });
    board = readBoardFromYDoc(yDoc);
    updateUndoState();
    return { id: next.id, label: next.label, color: next.color };
  }

  function deleteUnusedLabel(id: string): void {
    if (!yDoc || isTrashed) return;
    const inUse = board.cards.some((card) => card.tags?.includes(id));
    if (inUse) return;
    removeLabelFromYDoc(yDoc, id);
    board = readBoardFromYDoc(yDoc);
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

  function beginListPointerDrag(event: PointerEvent, id: string): void {
    if (event.button !== 0 || renamingListId === id || isTrashed) return;
    const target = event.target as Element | null;
    if (target?.closest('button,input,textarea,select,[contenteditable]')) {
      return;
    }
    const chip = event.currentTarget as HTMLElement;
    const rect = chip.getBoundingClientRect();
    const sourceIndex = board.columns.findIndex((col) => col.id === id);
    if (sourceIndex < 0) return;

    event.preventDefault();
    listDrag = {
      id,
      pointerId: event.pointerId,
      grabX: event.clientX - rect.left,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      x: event.clientX,
      sourceIndex
    };
    listDropIndex = sourceIndex;
    listDragMoved = false;
    window.addEventListener('pointermove', moveListPointerDrag, true);
    window.addEventListener('pointerup', finishListPointerDrag, true);
    window.addEventListener('pointercancel', cancelListPointerDrag, true);
  }

  function listReorderElements(): HTMLElement[] {
    return Array.from(
      toolbarScrollEl?.querySelectorAll<HTMLElement>('[data-reorder-id]') ?? []
    );
  }

  function moveListPointerDrag(event: PointerEvent): void {
    if (!listDrag || event.pointerId !== listDrag.pointerId) return;
    event.preventDefault();
    const toolbar = toolbarScrollEl;
    if (toolbar) {
      const rect = toolbar.getBoundingClientRect();
      if (event.clientX < rect.left + 32) toolbar.scrollLeft -= 12;
      else if (event.clientX > rect.right - 32) toolbar.scrollLeft += 12;
    }

    listDrag = { ...listDrag, x: event.clientX };
    listDragMoved = true;
    listDropIndex = horizontalInsertionIndex(
      board.columns,
      listDrag.id,
      listReorderElements(),
      event.clientX
    );
  }

  function finishListPointerDrag(event: PointerEvent): void {
    if (!listDrag || event.pointerId !== listDrag.pointerId) return;
    event.preventDefault();
    const drag = listDrag;
    const dropIndex = listDropIndex ?? drag.sourceIndex;
    cleanupListPointerDrag();

    if (dropIndex === drag.sourceIndex) return;
    commitColumnOrder(moveItemToIndex(board.columns, drag.id, dropIndex));
  }

  function cancelListPointerDrag(event: PointerEvent): void {
    if (!listDrag || event.pointerId !== listDrag.pointerId) return;
    cleanupListPointerDrag();
  }

  function cleanupListPointerDrag(): void {
    window.removeEventListener('pointermove', moveListPointerDrag, true);
    window.removeEventListener('pointerup', finishListPointerDrag, true);
    window.removeEventListener('pointercancel', cancelListPointerDrag, true);
    listDrag = null;
    listDropIndex = null;
    listDragMoved = false;
  }

  function commitColumnOrder(columns: KanbanColumnData[]): void {
    if (!yDoc || isTrashed) return;
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

  /**
   * Did this doc update come from the user editing *here*? Widget reconciles
   * carry `KANBAN_LOCAL_ORIGIN`; undo/redo transactions carry the UndoManager
   * itself. Everything else (the default-board seed, a history restore, collab
   * peers, provider (re)connect state) is not a local edit and must not drive
   * the history snapshot.
   */
  function isLocalEditOrigin(origin: unknown): boolean {
    return origin === KANBAN_LOCAL_ORIGIN || origin === undoManager;
  }

  function historyIdleMs(): number {
    const v = Number(getSettingValue('data.historyIdleSeconds'));
    return (Number.isFinite(v) && v > 0 ? v : HISTORY_IDLE_DEFAULT_S) * 1000;
  }

  /**
   * Arm the idle snapshot. Deliberately a *deadline*, not a debounce: an armed
   * timer is left running rather than restarted on every subsequent update.
   * A board's doc keeps getting updates it doesn't control (collab peers, a
   * reconnecting provider), and restarting on those pushed the capture past
   * the idle delay indefinitely, so the automatic snapshot never happened.
   */
  function scheduleHistoryCapture(): void {
    if (isTrashed) return;
    historyDirty = true;
    if (historyTimer) return;
    historyTimer = setTimeout(() => {
      historyTimer = null;
      void captureHistoryVersion('edited');
    }, historyIdleMs());
  }

  /** Manual "refresh history": capture now and restart the idle deadline. */
  async function snapshotHistoryNow(): Promise<void> {
    if (historyTimer) {
      clearTimeout(historyTimer);
      historyTimer = null;
    }
    await captureHistoryVersion('edited');
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
      const signingMaterial = await getOrCreateCollabSigningMaterial();
      const room = await noteRoomInfo(noteId, signingMaterial?.publicKeyB64);
      if (!room) return;
      provider = new CollabProvider({
        url: collabUrl,
        roomId: room.room_id,
        joinPrivateKeyPkcs8B64: room.join_private_key_pkcs8_b64,
        keyBytes: base64ToBytes(room.key_b64),
        doc: yDoc,
        awareness,
        auth: collabAuthForRoom(room, signingMaterial),
        requireSignedWrites: room.collab_epoch > 0,
        onAuthStale: () => {
          void setupCollabProvider();
        }
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
      // save; sync-merge updates skip it (already persisted). History, though,
      // tracks only what *this* editor changed: peer/provider traffic must not
      // arm (or keep pushing back) the idle snapshot.
      localYDoc.on('update', (_update: Uint8Array, origin: unknown) => {
        if (!saveReady) return;
        if (origin === REMOTE_SYNC_ORIGIN) return;
        scheduleSave();
        if (!capturingHistory && isLocalEditOrigin(origin))
          scheduleHistoryCapture();
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
      void listen('collab-credentials-changed', (payload) => {
        if (collabCredentialsChangedForNote(payload, noteId)) {
          void setupCollabProvider();
        }
      }).then((unlisten) => {
        unsubCollabCredentials = unlisten;
      });

      // Command-bus listener: handle app-level active-note search and displace
      // any hidden editor listener so markdown/pdf commands don't leak across
      // panes (same rationale as the other custom note editors).
      editorListener = {
        kind: 'kanban',
        host,
        noteId,
        onCommand: (id: string) => {
          if (id === SEARCH_ACTIVE_NOTE_COMMAND) {
            openKanbanSearch();
            return true;
          }
          return false;
        }
      };
      registerEditor(editorListener);

      unregisterHistory = registerNoteHistory(noteId, {
        currentSnapshot: () => currentSnapshot(),
        restoreSnapshot: (snapshot) => restoreSnapshot(snapshot),
        snapshotNow: () => snapshotHistoryNow()
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
    el.addEventListener('focusin', onFocusIn);
    return () => {
      el.removeEventListener('focusin', onFocusIn);
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
    cleanupListPointerDrag();
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
    unsubCollabCredentials?.();
    unsubCollabCredentials = null;
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

                {#each displayedColumns as col (col.id)}
                  <div
                    class="kanban-list-chip"
                    class:kanban-list-chip-placeholder={listDragMoved &&
                      listDrag?.id === col.id}
                    data-reorder-id={col.id}
                    role="group"
                    aria-label={col.label}
                    aria-grabbed={listDrag?.id === col.id}
                    onpointerdown={(event) =>
                      beginListPointerDrag(event, col.id)}
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
            {#if searchOpen}
              <KanbanSearchPanel
                bind:this={searchPanel}
                filters={searchFilters}
                columns={board.columns}
                priorities={priorityOptions}
                labels={board.labels ?? []}
                users={userOptions}
                matchCount={searchMatchCount}
                totalCount={board.cards.length}
                onChange={updateKanbanSearch}
                onClose={closeKanbanSearch}
              />
            {/if}
          {/if}
          <!-- Right-click a card to open the Edit/Duplicate/Delete menu. -->
          <div
            class="relative min-h-0 flex-1"
            role="presentation"
            oncontextmenucapture={openCardMenu}
            onpointerdowncapture={rememberCardEditorPressOrigin}
            onclickcapture={closeCardEditorOnBoardClick}
          >
            <Kanban
              cards={board.cards}
              columns={board.columns}
              card={cardShape}
              cardContent={KanbanCardContent}
              readonly={isTrashed}
              init={handleInit}
            />
            {#if api && !isTrashed}
              <Editor {api} items={editorItems} css="kanban-card-editor" />
            {/if}
          </div>
          <KanbanCardMenu {api} css="kanban-card-menu" bind:this={cardMenu} />
        </div>
      </ThemeComponent>
    </div>
    {#if listDrag && listDragMoved && draggedColumn}
      <div
        class="kanban-list-drag-ghost"
        style:left={`${listDrag.x - listDrag.grabX}px`}
        style:top={`${listDrag.top}px`}
        style:width={`${listDrag.width}px`}
        style:height={`${listDrag.height}px`}
        aria-hidden="true"
      >
        <span class="kanban-list-label" title={draggedColumn.label}
          >{draggedColumn.label}</span
        >
        <div class="kanban-list-ghost-menu">
          <Ellipsis aria-hidden="true" />
        </div>
      </div>
    {/if}
    {#if listMenu}
      <AppContextMenu
        x={listMenu.x}
        y={listMenu.y}
        items={listMenuItems}
        layer="editor"
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
    --wx-color-font-disabled: var(--muted-foreground);
    --wx-color-primary: var(--primary);
    --wx-color-primary-font: var(--primary-foreground);
    --wx-color-link: var(--primary);
    --wx-color-danger: var(--destructive);
    --wx-color-disabled: var(--muted);
    --wx-color-disabled-alt: var(--muted);
    --wx-icon-color: var(--muted-foreground);
    --wx-border: 1px solid var(--border);
    --wx-border-light: 1px solid var(--border);
    --wx-border-medium: 1px solid var(--border);
    --wx-border-radius: var(--radius-md);
    --wx-radius-major: var(--radius-md);
    --wx-font-family: inherit;
    --wx-font-size: 0.875rem;
    --wx-line-height: 1.25rem;
    --wx-font-size-md: 0.875rem;
    --wx-line-height-md: 1.5rem;
    --wx-font-size-hd: 1rem;
    --wx-line-height-hd: 1.5rem;
    --wx-font-weight: 400;
    --wx-font-weight-md: 600;
    --wx-font-weight-b: 700;
    --wx-shadow-light:
      0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
    --wx-shadow-medium: none;
    --wx-box-shadow:
      0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);

    /* editor / form surfaces */
    --wx-field-gutter: 1rem;
    --wx-input-background: transparent;
    --wx-input-background-disabled: var(--muted);
    --wx-input-border: 1px solid var(--input);
    --wx-input-border-disabled: 1px solid var(--border);
    --wx-input-border-focus: 1px solid var(--ring);
    --wx-input-border-radius: var(--radius-sm);
    --wx-input-font-color: var(--foreground);
    --wx-input-icon-color: var(--muted-foreground);
    --wx-input-placeholder-color: var(--muted-foreground);
    --wx-label-font-color: var(--foreground);
    --wx-popup-background: var(--popover);
    --wx-popup-border: 1px solid var(--border);
    --wx-popup-border-radius: var(--radius-md);
    --wx-popup-shadow: var(--wx-shadow-light);
    --wx-modal-background: var(--background);
    --wx-modal-border: 1px solid var(--border);
    --wx-modal-border-radius: 0;
    --wx-modal-shadow: none;
    --wx-modal-width: 28rem;
    --wx-button-background: var(--secondary);
    --wx-button-border: 1px solid transparent;
    --wx-button-border-radius: var(--radius-sm);
    --wx-button-danger-font-color: var(--destructive-foreground);
    --wx-button-font-color: var(--secondary-foreground);
    --wx-button-pressed: var(--accent);
    --wx-button-primary-pressed: var(--primary);
    --wx-button-danger-pressed: var(--destructive);
    --wx-button-box-shadow: none;
    --wx-button-primary-box-shadow: none;
    --wx-slider-background: var(--muted);
    --wx-slider-primary: var(--primary);

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
    touch-action: none;
    transition:
      border-color 120ms,
      box-shadow 120ms,
      opacity 120ms,
      transform 120ms;
  }
  .kanban-list-chip:active {
    cursor: grabbing;
  }
  .kanban-list-chip:focus-within {
    border-color: var(--ring);
    box-shadow: 0 0 0 1px var(--ring);
  }
  .kanban-list-chip-placeholder {
    opacity: 0.18;
  }
  .kanban-list-drag-ghost {
    position: fixed;
    z-index: 250;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    border: 1px solid var(--ring);
    border-radius: 0.375rem;
    background: var(--card);
    padding-left: 0.5rem;
    padding-right: 0.125rem;
    box-shadow:
      0 0 0 1px var(--ring),
      0 8px 20px rgb(0 0 0 / 0.18);
    pointer-events: none;
    will-change: left;
  }
  .kanban-list-ghost-menu {
    display: inline-flex;
    width: 2rem;
    height: 2rem;
    align-items: center;
    justify-content: center;
    color: var(--muted-foreground);
  }
  .kanban-list-ghost-menu :global(svg) {
    width: 1rem;
    height: 1rem;
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
  :global(.kanban-scope .wx-sidearea:has(.kanban-card-editor)) {
    z-index: 240;
    background: var(--background);
    color: var(--foreground);
  }
  :global(.kanban-scope .wx-sidearea:has(.kanban-card-editor) + .wx-overlay) {
    z-index: 230;
  }
  :global(.wx-popup),
  :global(.wx-menu.kanban-card-menu) {
    z-index: 250;
  }
  :global(.kanban-scope .kanban-card-editor) {
    background: var(--background);
    color: var(--foreground);
  }
  :global(.kanban-scope .kanban-card-editor .wx-content) {
    background: var(--background);
  }
  :global(.kanban-scope .kanban-card-editor .wx-sections) {
    margin-inline: 1.25rem;
  }
  :global(.kanban-scope .kanban-card-editor .wx-field) {
    margin-bottom: 1rem;
  }
  :global(.kanban-scope .kanban-card-editor .wx-label) {
    color: var(--foreground);
  }
  :global(.kanban-scope .kanban-card-editor input),
  :global(.kanban-scope .kanban-card-editor textarea),
  :global(.kanban-scope .kanban-card-editor .wx-richselect) {
    box-shadow: none;
    transition:
      border-color 120ms,
      box-shadow 120ms;
  }
  :global(.kanban-scope .kanban-card-editor input:focus),
  :global(.kanban-scope .kanban-card-editor textarea:focus),
  :global(.kanban-scope .kanban-card-editor .wx-richselect:focus) {
    box-shadow: 0 0 0 1px var(--ring);
  }
  :global(.kanban-scope .kanban-card-editor .wx-editor-toolbar) {
    padding-inline: 1.25rem;
  }
  :global(.kanban-scope .kanban-card-editor .wx-button.wx-icon) {
    background: var(--accent);
    color: var(--accent-foreground);
  }
  :global(.kanban-scope .kanban-card-editor .wx-button.wx-danger) {
    background: var(--destructive);
    color: var(--destructive-foreground);
  }
  :global(.wx-popup) {
    --wx-background-hover: var(--accent);
    --wx-input-font-family: inherit;
    --wx-input-font-size: 0.875rem;
    --wx-input-font-color: var(--popover-foreground);
    --wx-input-font-weight: 400;
    --wx-input-line-height: 1.25rem;
    --wx-input-padding: 0.375rem 0.5rem;
    --wx-popup-background: var(--popover);
    --wx-popup-border: 1px solid var(--border);
    --wx-popup-border-radius: var(--radius-md);
    --wx-popup-shadow:
      0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
  }
  :global(.wx-popup .wx-list) {
    scrollbar-width: thin;
    scrollbar-color: oklch(from var(--foreground) l c h / 0.3) transparent;
  }
  :global(.wx-menu.kanban-card-menu) {
    --wx-background: var(--popover);
    --wx-background-alt: var(--accent);
    --wx-border-medium: 1px solid var(--border);
    --wx-border-radius: var(--radius-md);
    --wx-color-font: var(--popover-foreground);
    --wx-color-font-disabled: var(--muted-foreground);
    --wx-font-family: inherit;
    --wx-font-size: 0.875rem;
    --wx-font-weight: 400;
    --wx-icon-color: var(--muted-foreground);
    --wx-icon-size: 1rem;
    --wx-shadow-light:
      0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);

    border: 1px solid var(--border);
    color: var(--popover-foreground);
    overflow: hidden;
  }
  :global(.wx-menu.kanban-card-menu .wx-option) {
    gap: 0.5rem;
    height: auto;
    min-height: 2rem;
    padding: 0.375rem 0.75rem;
    line-height: 1.25rem;
  }
  :global(.wx-menu.kanban-card-menu .wx-option:hover) {
    color: var(--accent-foreground);
  }
  :global(.wx-menu.kanban-card-menu .wx-value) {
    padding: 0;
  }
  :global(.wx-menu.kanban-card-menu .wx-icon) {
    margin-right: 0;
  }
  :global(.wx-menu.kanban-card-menu .wx-separator) {
    border-top-color: var(--border);
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
