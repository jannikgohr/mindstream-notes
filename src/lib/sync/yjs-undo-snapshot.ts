/**
 * A `Y.UndoManager`'s stacks as JSON, so they outlive the webview when the
 * worker unloads a hidden window (see `$lib/editor/retained-undo`).
 *
 * A stack item names Yjs items by ID, and undoing a deletion needs the
 * deleted content. The note Rust stores has collected that content, so the
 * capture carries this document as well, and a restore loads it before the
 * stored state. An undone deletion re-inserts copies and links each original
 * to its copy in memory only (`Item.redone`), so the capture keeps the links.
 */

import * as Y from 'yjs';
import { base64ToBytes, bytesToBase64 } from '$lib/editor/base64';

interface StackItemJSON {
  insertions: string;
  deletions: string;
}

export interface YjsUndoJSON {
  state: string;
  /** `[client, clock, length, redone client, redone clock]` per item. */
  redone: number[][];
  undo: StackItemJSON[];
  redo: StackItemJSON[];
}

type DeleteSet = Y.Snapshot['ds'];

const encodeSet = (ds: DeleteSet) =>
  bytesToBase64(Y.encodeSnapshot(Y.createSnapshot(ds, new Map())));
const decodeSet = (text: string) => Y.decodeSnapshot(base64ToBytes(text)).ds;

/** The manager's stacks, or null when both are empty. */
export function captureYjsUndo(manager: Y.UndoManager): YjsUndoJSON | null {
  if (manager.undoStack.length + manager.redoStack.length === 0) return null;
  const stack = (items: typeof manager.undoStack) =>
    items.map((item) => ({
      insertions: encodeSet(item.insertions),
      deletions: encodeSet(item.deletions)
    }));
  const redone: number[][] = [];
  for (const [client, structs] of manager.doc.store.clients) {
    for (const struct of structs) {
      if (struct instanceof Y.Item && struct.redone) {
        const { clock } = struct.id;
        const to = struct.redone;
        redone.push([client, clock, struct.length, to.client, to.clock]);
      }
    }
  }
  return {
    state: bytesToBase64(Y.encodeStateAsUpdate(manager.doc)),
    redone,
    undo: stack(manager.undoStack),
    redo: stack(manager.redoStack)
  };
}

/**
 * Load the captured document into a new, empty `doc`, before the stored
 * state. Call the returned function with the doc's new undo manager.
 */
export function loadRetainedYjsUndo(
  doc: Y.Doc,
  saved: YjsUndoJSON
): (manager: Y.UndoManager) => void {
  const gcFilter = doc.gcFilter;
  // Nothing is collected until the manager has said what it keeps.
  doc.gcFilter = () => false;
  try {
    Y.applyUpdate(doc, base64ToBytes(saved.state));
  } catch (err) {
    console.warn('[undo] retained document unreadable', err);
  }
  return (manager) => {
    try {
      doc.transact((tr) => {
        for (const [client, clock, length, toClient, toClock] of saved.redone) {
          const item = Y.getItemCleanStart(tr, Y.createID(client, clock));
          if (item.length > length) {
            Y.getItemCleanStart(tr, Y.createID(client, clock + length));
          }
          item.redone = Y.createID(toClient, toClock);
        }
      });
      const stack = (items: StackItemJSON[]) =>
        items.map((item) => {
          const deletions = decodeSet(item.deletions);
          doc.transact((tr) =>
            Y.iterateDeletedStructs(tr, deletions, (struct) => {
              // As the manager does for each deletion it records.
              let kept: Y.Item | null =
                struct instanceof Y.Item ? struct : null;
              while (kept !== null && !kept.keep) {
                kept.keep = true;
                kept = (kept.parent as Y.AbstractType<unknown>)._item;
              }
            })
          );
          return {
            insertions: decodeSet(item.insertions),
            deletions,
            meta: new Map()
          };
        });
      manager.undoStack.push(...stack(saved.undo));
      manager.redoStack.push(...stack(saved.redo));
    } catch (err) {
      console.warn('[undo] retained history unreadable', err);
    } finally {
      doc.gcFilter = gcFilter;
    }
  };
}
