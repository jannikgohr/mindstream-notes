import * as Y from 'yjs';
import { renderKanbanDescription } from './description-markdown';
import {
  boardToPlainText,
  readBoardFromYDoc,
  upsertBoardIntoYDoc,
  KANBAN_RENDER_ORIGIN
} from './kanban-yjs';

/** Capture before the first await so closing the editor cannot discard its save.
 * Rendered descriptions belong to this snapshot and never overwrite newer edits. */
export function captureKanbanSave(
  doc: Y.Doc
): () => Promise<{ body: string; yrs_state: number[] }> {
  const snapshotDoc = new Y.Doc();
  Y.applyUpdate(snapshotDoc, Y.encodeStateAsUpdate(doc));
  return async () => {
    try {
      const snapshot = readBoardFromYDoc(snapshotDoc);
      await Promise.all(
        snapshot.cards.map(async (card) => {
          card.descriptionHtml = card.description
            ? await renderKanbanDescription(card.description)
            : undefined;
        })
      );
      upsertBoardIntoYDoc(snapshotDoc, snapshot, KANBAN_RENDER_ORIGIN);
      return {
        body: boardToPlainText(snapshot),
        yrs_state: Array.from(Y.encodeStateAsUpdate(snapshotDoc))
      };
    } finally {
      snapshotDoc.destroy();
    }
  };
}
