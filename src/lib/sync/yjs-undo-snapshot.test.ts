import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  captureYjsUndo,
  loadRetainedYjsUndo,
  type YjsUndoJSON
} from './yjs-undo-snapshot';

const LOCAL = Symbol('local');

function board(doc: Y.Doc) {
  const cards = doc.getArray<string>('cards');
  const undo = new Y.UndoManager(cards, {
    trackedOrigins: new Set([LOCAL]),
    captureTimeout: 0
  });
  return { cards, undo };
}

/** What Rust stores: the same document with deleted content collected. */
function stored(doc: Y.Doc): Uint8Array {
  const collected = new Y.Doc();
  Y.applyUpdate(collected, Y.encodeStateAsUpdate(doc));
  return Y.encodeStateAsUpdate(collected);
}

/** The window is unloaded and built again from the stored note. */
function reopen(saved: YjsUndoJSON | null, state: Uint8Array) {
  const doc = new Y.Doc();
  const finish = saved ? loadRetainedYjsUndo(doc, saved) : null;
  Y.applyUpdate(doc, state);
  const after = board(doc);
  finish?.(after.undo);
  return after;
}

describe('Yjs undo across an unload', () => {
  it('brings back a deleted card, which the stored note no longer holds', () => {
    const before = board(new Y.Doc());
    before.cards.doc!.transact(() => before.cards.push(['a', 'b']), LOCAL);
    before.cards.doc!.transact(() => before.cards.delete(0, 1), LOCAL);
    const saved = JSON.parse(
      JSON.stringify(captureYjsUndo(before.undo))
    ) as YjsUndoJSON;
    const state = stored(before.cards.doc!);

    const without = reopen(null, state);
    expect(without.undo.undoStack).toHaveLength(0);

    const after = reopen(saved, state);
    after.undo.undo();
    expect(after.cards.toArray()).toEqual(['a', 'b']);
    after.undo.undo();
    expect(after.cards.toArray()).toEqual([]);
    after.undo.redo();
    after.undo.redo();
    expect(after.cards.toArray()).toEqual(['b']);
  });

  it('still undoes an add after its deletion was undone', () => {
    const before = board(new Y.Doc());
    before.cards.doc!.transact(() => before.cards.push(['a', 'b']), LOCAL);
    before.cards.doc!.transact(() => before.cards.delete(0, 1), LOCAL);
    before.undo.undo();
    const saved = captureYjsUndo(before.undo)!;

    const after = reopen(saved, stored(before.cards.doc!));
    expect(after.cards.toArray()).toEqual(['a', 'b']);
    after.undo.undo();
    expect(after.cards.toArray()).toEqual([]);
  });

  it('leaves a peer edit made while unloaded alone', () => {
    const before = board(new Y.Doc());
    before.cards.doc!.transact(() => before.cards.push(['mine']), LOCAL);
    const saved = captureYjsUndo(before.undo)!;
    const peer = new Y.Doc();
    Y.applyUpdate(peer, stored(before.cards.doc!));
    peer.getArray<string>('cards').push(['theirs']);

    const after = reopen(saved, stored(peer));
    after.undo.undo();
    expect(after.cards.toArray()).toEqual(['theirs']);
  });

  it('has nothing to keep when nothing was done', () => {
    expect(captureYjsUndo(board(new Y.Doc()).undo)).toBeNull();
  });
});
