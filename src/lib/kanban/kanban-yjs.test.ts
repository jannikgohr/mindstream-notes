import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  KANBAN_LOCAL_ORIGIN,
  boardToPlainText,
  createKanbanUndoManager,
  defaultColumns,
  isBoardEmpty,
  isLocalOnly,
  observeBoard,
  readBoardFromYDoc,
  removeCardFromYDoc,
  removeColumnFromYDoc,
  removeLabelFromYDoc,
  seedDefaultBoard,
  upsertBoardIntoYDoc,
  writeBoardToYDoc,
  type KanbanBoard
} from './kanban-yjs';

function sampleBoard(): KanbanBoard {
  return {
    columns: [
      { id: 'todo', label: 'To Do', order: 0 },
      { id: 'done', label: 'Done', order: 1 }
    ],
    labels: [
      { id: 'blocked', label: 'Blocked', color: '#ef4444', order: 0 },
      { id: 'frontend', label: 'Frontend', color: '#3b82f6', order: 1 }
    ],
    cards: [
      {
        id: 'c1',
        label: 'First',
        column: 'todo',
        description: 'do the thing',
        priority: 2,
        tags: ['blocked'],
        users: ['alice'],
        deadline: new Date('2026-01-02T00:00:00.000Z'),
        order: 0
      },
      { id: 'c2', label: 'Second', column: 'done', order: 1 }
    ]
  };
}

describe('kanban-yjs round-trip', () => {
  it('writes a board and reads it back unchanged', () => {
    const doc = new Y.Doc();
    const board = sampleBoard();
    writeBoardToYDoc(doc, board);
    const read = readBoardFromYDoc(doc);

    expect(read.columns).toEqual(board.columns);
    expect(read.cards).toHaveLength(2);
    const c1 = read.cards.find((c) => c.id === 'c1')!;
    expect(c1.label).toBe('First');
    expect(c1.description).toBe('do the thing');
    expect(c1.priority).toBe(2);
    expect(c1.tags).toEqual(['blocked']);
    expect(c1.users).toEqual(['alice']);
    expect(read.labels).toEqual(board.labels);
    // Deadline serialises to ISO and hydrates back to an equal Date.
    expect(c1.deadline).toBeInstanceOf(Date);
    expect(c1.deadline?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('sorts by order and tiebreaks by id', () => {
    const doc = new Y.Doc();
    writeBoardToYDoc(doc, {
      columns: [],
      cards: [
        { id: 'b', label: 'B', column: 'todo', order: 5 },
        { id: 'a', label: 'A', column: 'todo', order: 5 },
        { id: 'c', label: 'C', column: 'todo', order: 1 }
      ]
    });
    expect(readBoardFromYDoc(doc).cards.map((c) => c.id)).toEqual([
      'c',
      'a',
      'b'
    ]);
  });

  it('upserts changed fields, adds new cards and drops removed ones', () => {
    const doc = new Y.Doc();
    writeBoardToYDoc(doc, sampleBoard());
    writeBoardToYDoc(doc, {
      columns: [{ id: 'todo', label: 'Backlog', order: 0 }],
      labels: [{ id: 'urgent', label: 'Urgent', color: '#f59e0b', order: 0 }],
      cards: [
        { id: 'c1', label: 'First (edited)', column: 'todo', order: 0 },
        { id: 'c3', label: 'Third', column: 'todo', order: 1 }
      ]
    });
    const read = readBoardFromYDoc(doc);
    expect(read.columns).toEqual([{ id: 'todo', label: 'Backlog', order: 0 }]);
    expect(read.labels).toEqual([
      { id: 'urgent', label: 'Urgent', color: '#f59e0b', order: 0 }
    ]);
    expect(read.cards.map((c) => c.id)).toEqual(['c1', 'c3']);
    const c1 = read.cards.find((c) => c.id === 'c1')!;
    expect(c1.label).toBe('First (edited)');
    // Cleared field (description) is gone after the edit.
    expect(c1.description).toBeUndefined();
  });
});

describe('kanban-yjs additive live-editing (data-loss guard)', () => {
  it('upsert does NOT delete doc cards missing from a partial snapshot', () => {
    // The live editor's widget snapshot can be transiently incomplete (e.g.
    // right after a remote re-init). Upserting that partial view must never
    // drop the cards it happens to omit — that was the data-loss bug.
    const doc = new Y.Doc();
    writeBoardToYDoc(doc, sampleBoard()); // doc has c1, c2
    upsertBoardIntoYDoc(doc, {
      columns: [],
      cards: [{ id: 'c1', label: 'First (edited)', column: 'todo', order: 0 }]
    });
    const ids = readBoardFromYDoc(doc)
      .cards.map((c) => c.id)
      .sort();
    // c2 survives even though the snapshot omitted it.
    expect(ids).toEqual(['c1', 'c2']);
    expect(readBoardFromYDoc(doc).cards.find((c) => c.id === 'c1')?.label).toBe(
      'First (edited)'
    );
  });

  it('upsert adds a brand-new card without touching the rest', () => {
    const doc = new Y.Doc();
    writeBoardToYDoc(doc, sampleBoard());
    upsertBoardIntoYDoc(doc, {
      columns: [],
      cards: [{ id: 'c3', label: 'Third', column: 'todo', order: 2 }]
    });
    expect(
      readBoardFromYDoc(doc)
        .cards.map((c) => c.id)
        .sort()
    ).toEqual(['c1', 'c2', 'c3']);
    expect(readBoardFromYDoc(doc).labels).toEqual(sampleBoard().labels);
  });

  it('upsert adds labels without pruning existing labels', () => {
    const doc = new Y.Doc();
    writeBoardToYDoc(doc, sampleBoard());
    upsertBoardIntoYDoc(doc, {
      columns: [],
      cards: [],
      labels: [{ id: 'review', label: 'Review', color: '#22c55e', order: 2 }]
    });
    expect(readBoardFromYDoc(doc).labels?.map((label) => label.id)).toEqual([
      'blocked',
      'frontend',
      'review'
    ]);
  });

  it('removeLabelFromYDoc deletes only the label definition', () => {
    const doc = new Y.Doc();
    writeBoardToYDoc(doc, sampleBoard());
    removeLabelFromYDoc(doc, 'frontend');
    const read = readBoardFromYDoc(doc);
    expect(read.labels?.map((label) => label.id)).toEqual(['blocked']);
    expect(read.cards.find((card) => card.id === 'c1')?.tags).toEqual([
      'blocked'
    ]);
  });

  it('removeCardFromYDoc deletes exactly one card by id', () => {
    const doc = new Y.Doc();
    writeBoardToYDoc(doc, sampleBoard());
    removeCardFromYDoc(doc, 'c1');
    expect(readBoardFromYDoc(doc).cards.map((c) => c.id)).toEqual(['c2']);
    // Removing an unknown id is a harmless no-op.
    removeCardFromYDoc(doc, 'nope');
    expect(readBoardFromYDoc(doc).cards.map((c) => c.id)).toEqual(['c2']);
  });

  it('removeColumnFromYDoc drops the column and, opt-in, its cards', () => {
    const doc = new Y.Doc();
    writeBoardToYDoc(doc, sampleBoard()); // cols: todo, done; c1@todo, c2@done
    // Keep cards: only the column row goes; the (now orphaned) card stays.
    removeColumnFromYDoc(doc, 'done', false);
    let read = readBoardFromYDoc(doc);
    expect(read.columns.map((c) => c.id)).toEqual(['todo']);
    expect(read.cards.map((c) => c.id).sort()).toEqual(['c1', 'c2']);

    // Delete cards too: the column and every card in it are removed.
    removeColumnFromYDoc(doc, 'todo', true);
    read = readBoardFromYDoc(doc);
    expect(read.columns).toEqual([]);
    // c1 was in todo (removed); c2 was in done (already column-less) — untouched.
    expect(read.cards.map((c) => c.id)).toEqual(['c2']);
  });
});

describe('kanban-yjs seeding', () => {
  it('seeds default columns into an empty doc only', () => {
    const doc = new Y.Doc();
    expect(isBoardEmpty(doc)).toBe(true);
    seedDefaultBoard(doc);
    expect(readBoardFromYDoc(doc).columns).toEqual(defaultColumns());

    // Second seed is a no-op — doesn't duplicate or reset.
    writeBoardToYDoc(doc, {
      ...readBoardFromYDoc(doc),
      cards: [{ id: 'x', label: 'X', column: 'todo', order: 0 }]
    });
    seedDefaultBoard(doc);
    expect(readBoardFromYDoc(doc).cards).toHaveLength(1);
  });
});

describe('kanban-yjs plaintext projection', () => {
  it('indexes card label names instead of only label ids', () => {
    const text = boardToPlainText(sampleBoard());
    expect(text).toContain('Blocked');
  });
});

describe('kanban-yjs community undo manager', () => {
  it('undoes and redoes local card and column edits', () => {
    const doc = new Y.Doc();
    writeBoardToYDoc(doc, sampleBoard());
    const undoManager = createKanbanUndoManager(doc);

    upsertBoardIntoYDoc(doc, {
      columns: [
        { id: 'done', label: 'Done', order: 0 },
        { id: 'todo', label: 'To Do', order: 1 }
      ],
      labels: [{ id: 'review', label: 'Review', color: '#22c55e', order: 2 }],
      cards: [{ id: 'c1', label: 'First edited', column: 'done', order: 0 }]
    });

    expect(undoManager.undoStack).toHaveLength(1);
    expect(readBoardFromYDoc(doc).columns.map((c) => c.id)).toEqual([
      'done',
      'todo'
    ]);
    expect(
      readBoardFromYDoc(doc).cards.find((c) => c.id === 'c1')
    ).toMatchObject({
      label: 'First edited',
      column: 'done'
    });
    expect(readBoardFromYDoc(doc).labels?.map((label) => label.id)).toContain(
      'review'
    );

    undoManager.undo();
    expect(readBoardFromYDoc(doc).columns.map((c) => c.id)).toEqual([
      'todo',
      'done'
    ]);
    expect(
      readBoardFromYDoc(doc).cards.find((c) => c.id === 'c1')
    ).toMatchObject({
      label: 'First',
      column: 'todo'
    });
    expect(
      readBoardFromYDoc(doc).labels?.map((label) => label.id)
    ).not.toContain('review');

    undoManager.redo();
    expect(readBoardFromYDoc(doc).columns.map((c) => c.id)).toEqual([
      'done',
      'todo'
    ]);
    expect(
      readBoardFromYDoc(doc).cards.find((c) => c.id === 'c1')
    ).toMatchObject({
      label: 'First edited',
      column: 'done'
    });
    expect(readBoardFromYDoc(doc).labels?.map((label) => label.id)).toContain(
      'review'
    );

    undoManager.destroy();
  });

  it('ignores remote-origin writes', () => {
    const doc = new Y.Doc();
    writeBoardToYDoc(doc, sampleBoard());
    const undoManager = createKanbanUndoManager(doc);

    writeBoardToYDoc(
      doc,
      {
        ...sampleBoard(),
        columns: [{ id: 'remote', label: 'Remote', order: 0 }]
      },
      'remote'
    );

    expect(undoManager.undoStack).toHaveLength(0);
    undoManager.destroy();
  });
});

describe('kanban-yjs echo guard', () => {
  it('flags local/seed writes and not cross-doc updates', () => {
    const doc = new Y.Doc();
    const events: Y.YEvent<Y.AbstractType<unknown>>[][] = [];
    const stop = observeBoard(doc, (e) => events.push(e));

    // Local write → observer sees only local-origin events.
    writeBoardToYDoc(doc, sampleBoard(), KANBAN_LOCAL_ORIGIN);
    expect(events).toHaveLength(1);
    expect(isLocalOnly(events[0])).toBe(true);

    // A remote update applied from a peer doc is NOT local-only, so the editor
    // would rebuild the widget props off it.
    const peer = new Y.Doc();
    writeBoardToYDoc(peer, {
      columns: [],
      cards: [{ id: 'remote', label: 'Remote', column: 'todo', order: 0 }]
    });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    expect(events).toHaveLength(2);
    expect(isLocalOnly(events[1])).toBe(false);

    stop();
  });

  it('a controlled editor would not duplicate a card on remote merge', () => {
    // Simulate the editor: local doc owns a card; a peer adds another; merge.
    const local = new Y.Doc();
    writeBoardToYDoc(local, {
      columns: defaultColumns(),
      cards: [{ id: 'c1', label: 'Local', column: 'todo', order: 0 }]
    });
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(local));
    writeBoardToYDoc(peer, {
      ...readBoardFromYDoc(peer),
      cards: [
        ...readBoardFromYDoc(peer).cards,
        { id: 'c2', label: 'Peer', column: 'doing', order: 1 }
      ]
    });
    // Bidirectional merge — the CRDT converges without duplicating c1.
    Y.applyUpdate(local, Y.encodeStateAsUpdate(peer));
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(local));
    const ids = readBoardFromYDoc(local)
      .cards.map((c) => c.id)
      .sort();
    expect(ids).toEqual(['c1', 'c2']);
  });
});

describe('boardToPlainText', () => {
  it('projects column and card text for search indexing', () => {
    const text = boardToPlainText(sampleBoard());
    expect(text).toContain('## To Do');
    expect(text).toContain('## Done');
    expect(text).toContain('First (To Do)');
    expect(text).toContain('do the thing');
    expect(text).toContain('Second (Done)');
  });
});

describe('kanban-yjs no-op writes', () => {
  it('does not emit a transaction when nothing changes', () => {
    const doc = new Y.Doc();
    writeBoardToYDoc(doc, sampleBoard());
    const observer = vi.fn();
    const stop = observeBoard(doc, observer);
    // Writing the identical board again should produce zero CRDT ops.
    writeBoardToYDoc(doc, readBoardFromYDoc(doc));
    expect(observer).not.toHaveBeenCalled();
    stop();
  });
});
