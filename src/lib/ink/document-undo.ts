/**
 * Turning a recorded [`UndoOp`] back into document mutations.
 *
 * Undo and redo are separate functions rather than one parameterised
 * pass because a few ops are not symmetric — a transform inverts, a
 * tombstone flips, a style patch replaces.
 */

import type { InkDocument } from './document';
import type { UndoOp } from './stroke-types';

export function applyUndoOp(doc: InkDocument, op: UndoOp): void {
  switch (op.kind) {
    case 'strokeAdded':
      doc.setStrokeTombstoned(op.id, true);
      break;
    case 'strokesAdded':
      doc.setStrokesTombstoned(op.ids, true);
      break;
    case 'eraserDrag':
    case 'clearAll':
    case 'selectionDelete':
      doc.setStrokesTombstoned(op.ids, false);
      break;
    case 'strokeSlice':
      // Restore the originals and drop every fragment the drag produced.
      doc.setStrokesTombstoned(op.removedOriginals, false);
      doc.setStrokesTombstoned(op.addedFragments, true);
      break;
    case 'selectionMove':
      doc.translateStrokeSet(new Set(op.ids), -op.dx, -op.dy);
      break;
    case 'selectionTransform':
      doc.transformStrokeSet(new Set(op.ids), op.inverse);
      break;
    case 'selectionStyle':
      doc.applyStrokeStyleSnapshot(op.before);
      break;
  }
}

export function applyRedoOp(doc: InkDocument, op: UndoOp): void {
  switch (op.kind) {
    case 'strokeAdded':
      doc.setStrokeTombstoned(op.id, false);
      break;
    case 'strokesAdded':
      doc.setStrokesTombstoned(op.ids, false);
      break;
    case 'eraserDrag':
    case 'clearAll':
    case 'selectionDelete':
      doc.setStrokesTombstoned(op.ids, true);
      break;
    case 'strokeSlice':
      // Re-erase the originals and bring back only the surviving fragments.
      doc.setStrokesTombstoned(op.removedOriginals, true);
      doc.setStrokesTombstoned(op.finalFragments, false);
      break;
    case 'selectionMove':
      doc.translateStrokeSet(new Set(op.ids), op.dx, op.dy);
      break;
    case 'selectionTransform':
      doc.transformStrokeSet(new Set(op.ids), op.transform);
      break;
    case 'selectionStyle':
      doc.applyStrokeStyleSnapshot(op.after);
      break;
  }
}
