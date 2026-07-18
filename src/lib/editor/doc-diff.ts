/**
 * Minimal replacement between two ProseMirror documents.
 *
 * Why this exists: `collabService.applyTemplate` is NOT a diff. It does
 *
 *     fragment.delete(0, fragment.length)      // drop the whole document
 *     applyUpdate(doc, encodeStateAsUpdate(prosemirrorToYDoc(node)))
 *
 * i.e. it deletes the entire XmlFragment and merges a freshly-built throwaway
 * Y.Doc. Yjs is append-only, so each call leaves tombstones for every item in
 * the old document AND inserts a complete new copy (under a fresh client id).
 * That is acceptable for a one-shot restore, but the raw-source editor feeds
 * markdown back on every debounce tick — doing it there would grow the
 * persisted `yrs_state` (and the bytes broadcast to peers) by a full document
 * copy every ~150ms while typing, and would clobber any concurrent peer edit.
 *
 * Instead we parse the markdown to a ProseMirror doc and replace only the range
 * that actually differs. y-prosemirror then translates that one step into Yjs
 * ops proportional to the real edit, and untouched regions — including a peer's
 * concurrent change elsewhere in the document — are left completely alone.
 *
 * This is the standard ProseMirror `findDiffStart` / `findDiffEnd` recipe.
 */

import type { Node as ProseNode, Slice } from '@milkdown/kit/prose/model';

export interface DocReplacement {
  /** Document position to replace from. */
  from: number;
  /** Document position to replace to. */
  to: number;
  /** The replacement content, taken from the new document. */
  slice: Slice;
}

/**
 * The smallest replacement that turns `current` into `next`, or `null` when the
 * documents are already identical (in which case the caller must dispatch
 * NOTHING — a no-op transaction would still append Yjs ops).
 */
export function minimalDocDiff(
  current: ProseNode,
  next: ProseNode
): DocReplacement | null {
  if (current.eq(next)) return null;

  const start = current.content.findDiffStart(next.content);
  // `findDiffStart` returns null only when the contents are equal, which
  // `eq` above already covers — but stay defensive.
  if (start == null) return null;

  const end = current.content.findDiffEnd(next.content);
  if (!end) return null;

  let { a: endA, b: endB } = end;
  // The diff scanned from both ends can overshoot past `start` when the same
  // text repeats around the change; push the ends back so the range stays
  // well-formed (from <= to).
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }

  return { from: start, to: endA, slice: next.slice(start, endB) };
}
