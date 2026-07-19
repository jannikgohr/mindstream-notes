/**
 * Yjs adapter for Kanban-board notes.
 *
 * A board lives in the note's Y.Doc as two `Y.Array`s of `Y.Map`s — one for
 * columns, one for cards — so field-level edits from different devices merge
 * cleanly (a title change on device A and a move on device B don't clobber each
 * other). This is the same at-rest + live-collab substrate every other note
 * kind uses: `KanbanNoteEditor` serialises the doc as `yrs_state` into etebase
 * and attaches the generic `CollabProvider` for real-time sync.
 *
 * Ordering is carried in an `order` field on each card/column rather than in the
 * `Y.Array` position. Reordering a shared `Y.Array` across a merge is fiddly and
 * churns the CRDT; an integer `order` (last-writer-wins on conflict, id as a
 * stable tiebreak) keeps writes to a single field and never reshuffles the
 * array. New items append; display order is decided at read time.
 *
 * Echo guard: every local write is tagged with {@link KANBAN_LOCAL_ORIGIN}. The
 * editor's `observeDeep` handler ignores transactions carrying that origin, so
 * mirroring a local widget action into the doc doesn't bounce straight back and
 * remount the board — only genuine remote updates rebuild the widget props.
 */

import * as Y from 'yjs';

/** Transaction origin stamped on writes the local widget makes. */
export const KANBAN_LOCAL_ORIGIN = 'kanban-local';
/** Transaction origin for the one-time default-board seed. */
export const KANBAN_SEED_ORIGIN = 'kanban-seed';
/** Transaction origin for a history-snapshot restore. */
export const KANBAN_RESTORE_ORIGIN = 'kanban-restore';

const COLUMNS_KEY = 'kanban:columns';
const CARDS_KEY = 'kanban:cards';

export interface KanbanColumnData {
  id: string;
  label: string;
  collapsed?: boolean;
  order: number;
}

/**
 * A card, in the plain shape the SVAR widget consumes. `deadline` is an ISO
 * string in the Y.Doc but is hydrated to a `Date` for the widget (see
 * {@link readBoardFromYDoc}); the widget hands it back as a `Date`, which
 * {@link writeBoardToYDoc} re-serialises.
 */
export interface KanbanCardData {
  id: string;
  label: string;
  column: string;
  description?: string;
  priority?: number;
  progress?: number;
  deadline?: Date;
  tags?: string[];
  users?: string[];
  /** Id of another note this card links to (wikilink-to-note). */
  linkedNoteId?: string;
  order: number;
}

export interface KanbanBoard {
  columns: KanbanColumnData[];
  cards: KanbanCardData[];
}

/** Card fields that round-trip through the Y.Map, minus `id`/`order`. */
const CARD_FIELDS = [
  'label',
  'column',
  'description',
  'priority',
  'progress',
  'deadline',
  'tags',
  'users',
  'linkedNoteId'
] as const;

function columnsArray(doc: Y.Doc): Y.Array<Y.Map<unknown>> {
  return doc.getArray<Y.Map<unknown>>(COLUMNS_KEY);
}

function cardsArray(doc: Y.Doc): Y.Array<Y.Map<unknown>> {
  return doc.getArray<Y.Map<unknown>>(CARDS_KEY);
}

/** True when the doc has no board yet (freshly created / never opened). */
export function isBoardEmpty(doc: Y.Doc): boolean {
  return columnsArray(doc).length === 0 && cardsArray(doc).length === 0;
}

/** The columns a brand-new board starts with. */
export function defaultColumns(): KanbanColumnData[] {
  return [
    { id: 'todo', label: 'To Do', order: 0 },
    { id: 'doing', label: 'In Progress', order: 1 },
    { id: 'done', label: 'Done', order: 2 }
  ];
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Normalise a stored/widget field value for comparison + serialisation. */
function toStored(key: string, value: unknown): unknown {
  if (value == null || value === '') return undefined;
  if (key === 'deadline') {
    if (value instanceof Date) return value.toISOString();
    return typeof value === 'string' ? value : undefined;
  }
  return value;
}

/** Set `key` on `map` only when the stored value actually changes, so a
 *  no-op reconcile pass produces zero CRDT ops. Clears the key when the
 *  new value is empty. */
function setIfChanged(map: Y.Map<unknown>, key: string, next: unknown): void {
  const stored = toStored(key, next);
  const current = map.get(key);
  if (stored === undefined) {
    if (current !== undefined) map.delete(key);
    return;
  }
  if (!jsonEqual(current, stored)) map.set(key, stored);
}

function readCard(map: Y.Map<unknown>, index: number): KanbanCardData | null {
  const id = map.get('id');
  if (typeof id !== 'string') return null;
  const rawDeadline = map.get('deadline');
  const deadline =
    typeof rawDeadline === 'string' ? new Date(rawDeadline) : undefined;
  const orderRaw = map.get('order');
  return {
    id,
    label: (map.get('label') as string) ?? '',
    column: (map.get('column') as string) ?? '',
    description: map.get('description') as string | undefined,
    priority: map.get('priority') as number | undefined,
    progress: map.get('progress') as number | undefined,
    deadline:
      deadline && !Number.isNaN(deadline.getTime()) ? deadline : undefined,
    tags: map.get('tags') as string[] | undefined,
    users: map.get('users') as string[] | undefined,
    linkedNoteId: map.get('linkedNoteId') as string | undefined,
    order: typeof orderRaw === 'number' ? orderRaw : index
  };
}

function readColumn(
  map: Y.Map<unknown>,
  index: number
): KanbanColumnData | null {
  const id = map.get('id');
  if (typeof id !== 'string') return null;
  const orderRaw = map.get('order');
  return {
    id,
    label: (map.get('label') as string) ?? '',
    collapsed: (map.get('collapsed') as boolean | undefined) || undefined,
    order: typeof orderRaw === 'number' ? orderRaw : index
  };
}

function byOrder<T extends { order: number; id: string }>(a: T, b: T): number {
  if (a.order !== b.order) return a.order - b.order;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Materialise the board from the Y.Doc into the plain arrays the SVAR widget
 * consumes, sorted by `order`.
 */
export function readBoardFromYDoc(doc: Y.Doc): KanbanBoard {
  const columns: KanbanColumnData[] = [];
  columnsArray(doc).forEach((map, i) => {
    const col = readColumn(map, i);
    if (col) columns.push(col);
  });
  const cards: KanbanCardData[] = [];
  cardsArray(doc).forEach((map, i) => {
    const card = readCard(map, i);
    if (card) cards.push(card);
  });
  columns.sort(byOrder);
  cards.sort(byOrder);
  return { columns, cards };
}

function indexById(arr: Y.Array<Y.Map<unknown>>): Map<string, Y.Map<unknown>> {
  const out = new Map<string, Y.Map<unknown>>();
  arr.forEach((map) => {
    const id = map.get('id');
    if (typeof id === 'string') out.set(id, map);
  });
  return out;
}

/**
 * Reconcile the whole board into the Y.Doc: upsert changed fields on existing
 * items (matched by id), append new items, and rewrite `order`. When
 * `prune` is true (the default) it also DROPS doc items not present in `board`
 * — a full replace, used for the default-board seed, a history-snapshot
 * restore, and tests.
 *
 * The live editor must NOT prune. Pruning deletes any card the passed board
 * omits, and the widget snapshot can be transiently incomplete (e.g. right
 * after the widget re-inits from a remote merge, before an in-flight local
 * action is folded in). A prune in that window would delete real cards from the
 * doc and autosave the loss. The live path uses {@link upsertBoardIntoYDoc}
 * (additive) plus {@link removeCardFromYDoc} for explicit deletes instead, so a
 * card only ever leaves the doc on a genuine user delete.
 */
export function writeBoardToYDoc(
  doc: Y.Doc,
  board: KanbanBoard,
  origin: unknown = KANBAN_LOCAL_ORIGIN,
  prune = true
): void {
  doc.transact(() => {
    reconcileColumns(doc, board.columns, prune);
    reconcileCards(doc, board.cards, prune);
  }, origin);
}

/**
 * Additive board write for the live editor: upsert every column/card the widget
 * currently has, never delete. Safe to call with a partial/stale snapshot — the
 * worst case is a field update lands one action late, never data loss.
 */
export function upsertBoardIntoYDoc(
  doc: Y.Doc,
  board: KanbanBoard,
  origin: unknown = KANBAN_LOCAL_ORIGIN
): void {
  writeBoardToYDoc(doc, board, origin, false);
}

/**
 * Community-license undo/redo for the board. SVAR's built-in history is a PRO
 * feature, so the editor tracks our own Yjs writes instead. Only local widget
 * writes carry `KANBAN_LOCAL_ORIGIN`, which keeps remote sync merges and
 * history restores out of the user's undo stack.
 */
export function createKanbanUndoManager(doc: Y.Doc): Y.UndoManager {
  return new Y.UndoManager([columnsArray(doc), cardsArray(doc)], {
    trackedOrigins: new Set([KANBAN_LOCAL_ORIGIN]),
    captureTimeout: 0
  });
}

/** Remove a single card by id — the only way the live editor deletes a card. */
export function removeCardFromYDoc(
  doc: Y.Doc,
  id: string,
  origin: unknown = KANBAN_LOCAL_ORIGIN
): void {
  const arr = cardsArray(doc);
  doc.transact(() => {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr.get(i).get('id') === id) {
        arr.delete(i, 1);
        break;
      }
    }
  }, origin);
}

/**
 * Remove a column by id. SVAR has no delete-column action, so column removal is
 * driven by the app's own UI. `deleteCards` also drops every card in that
 * column (walked back-to-front so indices stay valid); pass false to keep the
 * cards (the caller is responsible for re-homing them first).
 */
export function removeColumnFromYDoc(
  doc: Y.Doc,
  id: string,
  deleteCards: boolean,
  origin: unknown = KANBAN_LOCAL_ORIGIN
): void {
  const cols = columnsArray(doc);
  const cards = cardsArray(doc);
  doc.transact(() => {
    for (let i = cols.length - 1; i >= 0; i--) {
      if (cols.get(i).get('id') === id) {
        cols.delete(i, 1);
        break;
      }
    }
    if (deleteCards) {
      for (let i = cards.length - 1; i >= 0; i--) {
        if (cards.get(i).get('column') === id) cards.delete(i, 1);
      }
    }
  }, origin);
}

function reconcileColumns(
  doc: Y.Doc,
  columns: KanbanColumnData[],
  prune: boolean
): void {
  const arr = columnsArray(doc);
  const existing = indexById(arr);
  const desiredIds = new Set(columns.map((c) => c.id));

  for (const col of columns) {
    const map = existing.get(col.id);
    if (map) {
      setIfChanged(map, 'label', col.label);
      setIfChanged(map, 'collapsed', col.collapsed);
      if (map.get('order') !== col.order) map.set('order', col.order);
    } else {
      const created = new Y.Map<unknown>();
      created.set('id', col.id);
      created.set('label', col.label);
      created.set('order', col.order);
      if (col.collapsed) created.set('collapsed', true);
      arr.push([created]);
    }
  }

  if (!prune) return;
  // Delete removed columns, walking back-to-front so indices stay valid.
  for (let i = arr.length - 1; i >= 0; i--) {
    const id = arr.get(i).get('id');
    if (typeof id === 'string' && !desiredIds.has(id)) arr.delete(i, 1);
  }
}

function reconcileCards(
  doc: Y.Doc,
  cards: KanbanCardData[],
  prune: boolean
): void {
  const arr = cardsArray(doc);
  const existing = indexById(arr);
  const desiredIds = new Set(cards.map((c) => c.id));

  for (const card of cards) {
    const fields = card as unknown as Record<string, unknown>;
    const map = existing.get(card.id);
    if (map) {
      for (const key of CARD_FIELDS) setIfChanged(map, key, fields[key]);
      if (map.get('order') !== card.order) map.set('order', card.order);
    } else {
      const created = new Y.Map<unknown>();
      created.set('id', card.id);
      created.set('order', card.order);
      for (const key of CARD_FIELDS) {
        const stored = toStored(key, fields[key]);
        if (stored !== undefined) created.set(key, stored);
      }
      arr.push([created]);
    }
  }

  if (!prune) return;
  for (let i = arr.length - 1; i >= 0; i--) {
    const id = arr.get(i).get('id');
    if (typeof id === 'string' && !desiredIds.has(id)) arr.delete(i, 1);
  }
}

/** Seed a fresh doc with the default columns (no-op if it already has data). */
export function seedDefaultBoard(doc: Y.Doc): void {
  if (!isBoardEmpty(doc)) return;
  writeBoardToYDoc(
    doc,
    { columns: defaultColumns(), cards: [] },
    KANBAN_SEED_ORIGIN
  );
}

/**
 * Plaintext projection of the board (column + card titles and descriptions)
 * written into the note `body` on save, so full-text search and content-stats
 * — which index `body` for non-pdf kinds — find cards by their text.
 */
export function boardToPlainText(board: KanbanBoard): string {
  const colLabel = new Map(board.columns.map((c) => [c.id, c.label]));
  const lines: string[] = [];
  for (const col of [...board.columns].sort(byOrder)) {
    lines.push(`## ${col.label}`);
  }
  for (const card of [...board.cards].sort(byOrder)) {
    const where = colLabel.get(card.column);
    lines.push(where ? `- ${card.label} (${where})` : `- ${card.label}`);
    if (card.description) lines.push(card.description);
  }
  return lines.join('\n');
}

/**
 * True when every event in the batch came from a local/seed/restore write —
 * i.e. nothing to fold back into the widget. The editor uses this to skip
 * rebuilding widget props on its own edits.
 */
export function isLocalOnly(
  events: Y.YEvent<Y.AbstractType<unknown>>[]
): boolean {
  return events.every((event) => {
    const origin = event.transaction.origin;
    return (
      origin === KANBAN_LOCAL_ORIGIN ||
      origin === KANBAN_SEED_ORIGIN ||
      origin === KANBAN_RESTORE_ORIGIN
    );
  });
}

/**
 * Observe both board arrays; `handler` fires once per transaction. A single
 * transaction can touch both the columns and the cards array, which would
 * otherwise invoke each `observeDeep` separately — we de-duplicate on the
 * transaction identity so the handler runs once. All events in a transaction
 * share its origin, so passing the first array's events is enough for the
 * origin check the caller does via {@link isLocalOnly}.
 */
export function observeBoard(
  doc: Y.Doc,
  handler: (events: Y.YEvent<Y.AbstractType<unknown>>[]) => void
): () => void {
  let lastTransaction: Y.Transaction | null = null;
  const onEvents = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    const transaction = events[0]?.transaction ?? null;
    if (transaction && transaction === lastTransaction) return;
    lastTransaction = transaction;
    handler(events);
  };
  columnsArray(doc).observeDeep(onEvents);
  cardsArray(doc).observeDeep(onEvents);
  return () => {
    columnsArray(doc).unobserveDeep(onEvents);
    cardsArray(doc).unobserveDeep(onEvents);
  };
}
