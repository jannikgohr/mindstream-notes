/**
 * Decode remote collaborators' cursors (broadcast by y-prosemirror on the WYSIWYG
 * side) into approximate LINES in the raw-source view — the read side of the
 * lightweight Phase 2 presence. No second Yjs structure: we reuse the awareness
 * cursor each peer already publishes, map it to a top-level ProseMirror block,
 * then to the source line where that block starts.
 *
 * The block→line table is derived from per-block markdown serialization
 * (`blockLineStarts`, pure + unit-tested); the awareness decode mirrors exactly
 * what y-prosemirror's own cursor renderer does (relative position → absolute PM
 * position via the sync binding's mapping).
 */

import * as Y from 'yjs';
import {
  relativePositionToAbsolutePosition,
  ySyncPluginKey
} from 'y-prosemirror';
import type { Awareness } from 'y-protocols/awareness';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { PeerPresence } from './source-presence-extension';

/**
 * Line (0-based) at which each top-level block starts in the whole-document
 * markdown, given each block already serialized to markdown. Blocks are joined
 * by a blank line (prosemirror-markdown's block separator), so every block
 * advances the cursor by its own line count plus one separator line.
 *
 *   ['# A', 'para', '- a\n- b']  →  [0, 2, 4]
 */
export function blockLineStarts(blocks: string[]): number[] {
  const starts: number[] = [];
  let line = 0;
  for (const block of blocks) {
    starts.push(line);
    const lines = block.length === 0 ? 1 : block.split('\n').length;
    line += lines + 1; // +1 blank separator line before the next block
  }
  return starts;
}

/** y-prosemirror only accepts 6-digit RGB; fall back to its default otherwise.
 *  Exported for unit tests. */
export function normalizeColor(color: unknown): string {
  return typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)
    ? color
    : '#ffa500';
}

/** Index of the top-level block containing `pos`, clamped to the doc.
 *  Exported for unit tests. */
export function topBlockIndexAt(
  doc: EditorView['state']['doc'],
  pos: number
): number {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(clamped);
  return Math.min(Math.max($pos.index(0), 0), Math.max(doc.childCount - 1, 0));
}

/**
 * Turn a decoded absolute caret position into a source-line marker — the pure
 * half of the presence decode, split out so it can be unit-tested without a
 * live y-prosemirror binding (which is what supplies `head`). Maps `head` to
 * its top-level block, then to that block's source line, and fills in the
 * peer's display name/colour with defaults.
 */
export function peerLineMarker(
  doc: EditorView['state']['doc'],
  head: number,
  clientId: number,
  user: { name?: string; color?: string } | undefined,
  lineStarts: number[]
): PeerPresence {
  const maxPos = Math.max(doc.content.size - 1, 0);
  const idx = topBlockIndexAt(doc, Math.min(head, maxPos));
  return {
    clientId,
    name: user?.name?.trim() || `User ${clientId}`,
    color: normalizeColor(user?.color),
    line: lineStarts[idx] ?? 0
  };
}

/**
 * Decode every remote peer's cursor to a source-line marker.
 *
 * `lineStarts` maps top-block index → 0-based source line (from
 * `blockLineStarts`). Returns an empty list until the y-prosemirror sync binding
 * exists (no mapping yet) or when a snapshot is active — matching the guard in
 * y-prosemirror's own cursor renderer.
 */
export function computeSourcePresence(
  view: EditorView,
  awareness: Awareness,
  lineStarts: number[]
): PeerPresence[] {
  const ystate = ySyncPluginKey.getState(view.state);
  if (
    !ystate ||
    !ystate.binding ||
    ystate.binding.mapping.size === 0 ||
    ystate.snapshot != null ||
    ystate.prevSnapshot != null
  ) {
    return [];
  }
  const doc = ystate.doc as Y.Doc;
  const type = ystate.type;
  const mapping = ystate.binding.mapping;

  const out: PeerPresence[] = [];
  awareness.getStates().forEach((aw, clientId) => {
    if (clientId === doc.clientID) return; // skip self
    const cursor = (aw as { cursor?: { head?: unknown } } | undefined)?.cursor;
    if (!cursor || cursor.head == null) return;

    let head: number | null = null;
    try {
      head = relativePositionToAbsolutePosition(
        doc,
        type,
        Y.createRelativePositionFromJSON(cursor.head),
        mapping
      );
    } catch {
      head = null;
    }
    if (head == null) return;

    const user = (aw as { user?: { name?: string; color?: string } }).user;
    out.push(peerLineMarker(view.state.doc, head, clientId, user, lineStarts));
  });
  return out;
}
