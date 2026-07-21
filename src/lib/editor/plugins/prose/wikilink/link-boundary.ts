/**
 * Editing at the edges of a note link.
 *
 * A note link is a normal ProseMirror link mark, so typing at its first or
 * last character is ambiguous: the user may mean "extend the link" or
 * "type next to it". These helpers implement that state machine — which
 * marks a typed run inherits, when a whole link is deleted as a unit, and
 * how the caret is placed after either.
 */

import { TextSelection, type EditorState } from '@milkdown/kit/prose/state';
import type { Mark } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import { parseNoteHref } from '../../wikilink-href';

/**
 * Pattern: `[[…]]` where the inside has no brackets and no newlines.
 * Non-greedy on the inside so `[[a]] [[b]]` matches twice rather than
 * once across both.
 *
 * Escape rules:
 *   - Outside a character class, `[` opens a class → must escape (`\[`).
 *     `]` is just a literal there → no escape needed.
 *   - Inside a character class, `[` is literal → no escape needed.
 *     `]` closes the class → must escape (`\]`).
 */
export const WIKILINK_RE = /\[\[([^[\]\n]+?)]]/g;

export interface NoteLinkTextRange {
  from: number;
  to: number;
  href: string;
  mark: Mark;
}

export interface LinkBoundaryEdit {
  pos: number;
  mark: Mark;
}

export interface LinkBoundaryMode {
  mode: 'inside' | 'outside';
  side: 'start' | 'end';
  /**
   * Is the link at this boundary an ID-backed note link? Boundary *behaviour*
   * (typing at an edge lands outside the link, arrows opt into editing its
   * text) applies to every link mark. The caret *translation* must not: it
   * compensates for the generated `[[` / `]]`, which only note links draw, so
   * applying it to a plain link renders the caret a bracket-width off.
   */
  noteLink: boolean;
}

export function noteLinkTextRanges(state: EditorState): NoteLinkTextRange[] {
  const ranges: NoteLinkTextRange[] = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const mark = node.marks.find((mark) => parseNoteHref(mark.attrs.href));
    if (!mark) return;
    const href = mark?.attrs.href;
    if (typeof href !== 'string') return;

    const last = ranges[ranges.length - 1];
    if (last && last.href === href && last.to === pos && last.mark.eq(mark)) {
      last.to = pos + node.text.length;
    } else {
      ranges.push({ from: pos, to: pos + node.text.length, href, mark });
    }
  });
  return ranges;
}

export function noteLinkDeletionRange(
  state: EditorState,
  event: KeyboardEvent
): { from: number; to: number } | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return null;
  if (!selection.empty) return { from: selection.from, to: selection.to };
  const pos = selection.from;

  if (event.key === 'Backspace') {
    if (pos === 0) return null;
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      return { from: pos - 1, to: pos };
    }
    const $from = selection.$from;
    if (!$from.parent.isTextblock) return null;
    const offset = $from.parentOffset;
    if (offset === 0) return null;
    const text = $from.parent.textBetween(
      0,
      $from.parent.content.size,
      '\n',
      '\n'
    );
    let start = offset;
    while (start > 0 && /\s/.test(text[start - 1])) start -= 1;
    while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
    return { from: $from.start() + start, to: pos };
  }

  if (event.key === 'Delete') {
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      return pos < state.doc.content.size ? { from: pos, to: pos + 1 } : null;
    }
    const $from = selection.$from;
    if (!$from.parent.isTextblock) return null;
    const offset = $from.parentOffset;
    const text = $from.parent.textBetween(
      0,
      $from.parent.content.size,
      '\n',
      '\n'
    );
    if (offset >= text.length) return null;
    let end = offset;
    while (end < text.length && /\s/.test(text[end])) end += 1;
    while (end < text.length && !/\s/.test(text[end])) end += 1;
    return { from: pos, to: $from.start() + end };
  }

  return null;
}

export function wholeNoteLinkDeletion(
  state: EditorState,
  event: KeyboardEvent
): { from: number; to: number; mark: Mark } | null {
  const deletion = noteLinkDeletionRange(state, event);
  if (!deletion || deletion.from >= deletion.to) return null;

  const range = noteLinkTextRanges(state).find(
    (range) =>
      deletion.from <= range.from &&
      deletion.to >= range.to &&
      deletion.from < range.to &&
      deletion.to > range.from
  );
  if (!range) return null;

  return { from: deletion.from, to: deletion.to, mark: range.mark };
}

export function linkMarkType(state: EditorState) {
  return state.schema.marks.link ?? null;
}

export function linkMarkIn(
  marks: readonly Mark[],
  state: EditorState
): Mark | null {
  const type = linkMarkType(state);
  if (!type) return null;
  return marks.find((mark) => mark.type === type) ?? null;
}

export function activeMarks(state: EditorState): readonly Mark[] {
  return state.storedMarks ?? state.selection.$from.marks();
}

export function marksWithoutLink(state: EditorState): Mark[] {
  const type = linkMarkType(state);
  if (!type) return [...activeMarks(state)];
  return activeMarks(state).filter((mark) => mark.type !== type);
}

export function marksWithLink(state: EditorState, mark: Mark): Mark[] {
  return [...mark.addToSet(marksWithoutLink(state))];
}

export function exactStoredLinkMark(
  state: EditorState,
  mark: Mark
): Mark | null {
  return state.storedMarks?.find((stored) => stored.eq(mark)) ?? null;
}

export function textNodeLinkMarkAtBoundary(
  state: EditorState,
  pos: number,
  side: 'before' | 'after'
): Mark | null {
  const $pos = state.doc.resolve(pos);
  const node = side === 'before' ? $pos.nodeBefore : $pos.nodeAfter;
  if (!node?.isText) return null;
  return linkMarkIn(node.marks, state);
}

export function trailingBoundaryLinkMark(
  state: EditorState,
  pos: number
): Mark | null {
  const before = textNodeLinkMarkAtBoundary(state, pos, 'before');
  if (!before) return null;
  const after = textNodeLinkMarkAtBoundary(state, pos, 'after');
  return after?.eq(before) ? null : before;
}

export function leadingBoundaryLinkMark(
  state: EditorState,
  pos: number
): Mark | null {
  const after = textNodeLinkMarkAtBoundary(state, pos, 'after');
  if (!after) return null;
  const before = textNodeLinkMarkAtBoundary(state, pos, 'before');
  return before?.eq(after) ? null : after;
}

export function boundaryEditMatches(
  edit: LinkBoundaryEdit | null,
  pos: number,
  mark: Mark | null
): boolean {
  return !!edit && !!mark && edit.pos === pos && edit.mark.eq(mark);
}

export function boundaryEditAt(
  edit: LinkBoundaryEdit | null,
  pos: number
): boolean {
  return !!edit && edit.pos === pos;
}

export function deleteNoteLinkText(
  view: EditorView,
  event: KeyboardEvent
): LinkBoundaryEdit | null {
  const deletion = wholeNoteLinkDeletion(view.state, event);
  if (!deletion) return null;

  const tr = view.state.tr.delete(deletion.from, deletion.to);
  const mappedPos = tr.mapping.map(deletion.from, -1);
  tr.setSelection(TextSelection.create(tr.doc, mappedPos));
  tr.setStoredMarks(marksWithLink(view.state, deletion.mark));
  view.dispatch(tr);
  return { pos: mappedPos, mark: deletion.mark };
}

// Delete one character while staying in boundary editing: Backspace eats the
// link character to the left (right-side editing), Delete the one to the right
// (left-side editing). Keeps the link mark stored and tracks the new caret so
// the caret doesn't pop "outside" the moment the link loses its last edge
// character. Returns null when the deletion would leave the link text (let the
// default handler — or the whole-link path — take over instead).
export function deleteInsideLinkBoundary(
  view: EditorView,
  event: KeyboardEvent,
  edit: LinkBoundaryEdit
): LinkBoundaryEdit | null {
  const { state } = view;
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const pos = selection.from;
  if (pos !== edit.pos) return null;

  if (event.key === 'Backspace') {
    if (pos === 0) return null;
    const before = textNodeLinkMarkAtBoundary(state, pos, 'before');
    if (!before?.eq(edit.mark)) return null;
    const nextPos = pos - 1;
    const tr = state.tr.delete(nextPos, pos);
    tr.setSelection(TextSelection.create(tr.doc, nextPos));
    tr.setStoredMarks(marksWithLink(state, edit.mark));
    view.dispatch(tr);
    return { pos: nextPos, mark: edit.mark };
  }

  if (event.key === 'Delete') {
    const after = textNodeLinkMarkAtBoundary(state, pos, 'after');
    if (!after?.eq(edit.mark)) return null;
    const tr = state.tr.delete(pos, pos + 1);
    tr.setSelection(TextSelection.create(tr.doc, pos));
    tr.setStoredMarks(marksWithLink(state, edit.mark));
    view.dispatch(tr);
    return { pos, mark: edit.mark };
  }

  return null;
}

// Outside the link, treat it as one atomic object: a plain Backspace sitting at
// its right edge, or a plain Delete sitting at its left edge, removes the whole
// link in one stroke instead of nibbling the outermost character — which reads
// as confusing when the caret isn't even in link-editing mode. Word-wise
// deletes (Ctrl/Alt/Meta) fall through to the existing handling.
export function removeAdjacentNoteLink(
  view: EditorView,
  event: KeyboardEvent,
  boundary: LinkBoundaryMode | null
): boolean {
  if (!boundary || boundary.mode !== 'outside') return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  const { state } = view;
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const pos = selection.from;

  let range: NoteLinkTextRange | undefined;
  if (event.key === 'Backspace' && boundary.side === 'end') {
    range = noteLinkTextRanges(state).find((r) => r.to === pos);
  } else if (event.key === 'Delete' && boundary.side === 'start') {
    range = noteLinkTextRanges(state).find((r) => r.from === pos);
  }
  if (!range) return false;

  event.preventDefault();
  const tr = state.tr.delete(range.from, range.to);
  tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(range.from, -1)));
  tr.setStoredMarks(marksWithoutLink(state));
  view.dispatch(tr);
  return true;
}

export function insertLinkBoundaryText(
  view: EditorView,
  pos: number,
  text: string,
  mark: Mark
): number | null {
  if (!text) return null;
  const marks = marksWithLink(view.state, mark);
  const textNode = view.state.schema.text(text, marks);
  const tr = view.state.tr.replaceWith(pos, pos, textNode);
  tr.setSelection(TextSelection.create(tr.doc, pos + text.length));
  tr.setStoredMarks(marks);
  view.dispatch(tr);
  return pos + text.length;
}

export function boundaryLinkMark(state: EditorState, pos: number): Mark | null {
  return (
    trailingBoundaryLinkMark(state, pos) ?? leadingBoundaryLinkMark(state, pos)
  );
}

export function shouldTypeOutsideLinkBoundary(
  state: EditorState,
  pos: number
): boolean {
  const boundaryMark = boundaryLinkMark(state, pos);
  if (!boundaryMark) return false;
  return !exactStoredLinkMark(state, boundaryMark);
}

/**
 * The boundary link the caret is inside of on *stored marks alone* — editing
 * with no active pin. The pin is dropped whenever something moves the caret
 * (a sibling plugin's transaction, a re-render), while the stored marks that
 * make typing land inside the link survive. Inserting then clears those marks,
 * so without re-pinning only the first character stays in the link.
 */
export function storedInsideBoundaryMark(
  state: EditorState,
  pos: number
): Mark | null {
  const boundaryMark = boundaryLinkMark(state, pos);
  if (!boundaryMark) return null;
  return exactStoredLinkMark(state, boundaryMark);
}

export function typeOutsideLinkBoundary(
  view: EditorView,
  from: number,
  to: number,
  text: string
): boolean {
  if (from !== to || !shouldTypeOutsideLinkBoundary(view.state, from)) {
    return false;
  }

  const type = linkMarkType(view.state);
  const tr = view.state.tr.insertText(text, from, to);
  if (type) tr.removeMark(from, from + text.length, type);
  tr.setStoredMarks(marksWithoutLink(view.state));
  view.dispatch(tr);
  return true;
}

export function toggleLinkBoundaryEditing(
  view: EditorView,
  event: KeyboardEvent,
  activeBoundaryEdit: LinkBoundaryEdit | null
): LinkBoundaryEdit | 'exit' | null {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return null;
  const { state } = view;
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;

  const pos = selection.from;
  const trailing = trailingBoundaryLinkMark(state, pos);
  const leading = leadingBoundaryLinkMark(state, pos);
  const activeTrailing = boundaryEditMatches(activeBoundaryEdit, pos, trailing);
  const activeLeading = boundaryEditMatches(activeBoundaryEdit, pos, leading);
  const activeAtBoundary = boundaryEditAt(activeBoundaryEdit, pos);
  const exitMark =
    (event.key === 'ArrowRight' &&
      trailing &&
      (activeAtBoundary ||
        activeTrailing ||
        exactStoredLinkMark(state, trailing))) ||
    (event.key === 'ArrowLeft' &&
      leading &&
      (activeAtBoundary ||
        activeLeading ||
        exactStoredLinkMark(state, leading)));
  if (exitMark) {
    event.preventDefault();
    view.dispatch(state.tr.setStoredMarks(marksWithoutLink(state)));
    return 'exit';
  }

  const enterMark =
    (event.key === 'ArrowLeft' &&
    trailing &&
    !activeTrailing &&
    !exactStoredLinkMark(state, trailing)
      ? trailing
      : null) ??
    (event.key === 'ArrowRight' &&
    leading &&
    !activeLeading &&
    !exactStoredLinkMark(state, leading)
      ? leading
      : null);
  if (!enterMark) return null;

  event.preventDefault();
  view.dispatch(state.tr.setStoredMarks(marksWithLink(state, enterMark)));
  return { pos, mark: enterMark };
}

// Arrow movement that stays within the link text: when the caret steps
// onto the display name's first or last position *from inside*, keep
// link editing active by pinning the boundary it lands on. Without
// this, the default caret move clears the stored marks, the boundary
// reads as "outside", and the next character falls out of the link —
// which felt like being kicked out of editing mid-word.
export function arrowWithinLinkText(
  view: EditorView,
  event: KeyboardEvent,
  activeEdit: LinkBoundaryEdit | null
): LinkBoundaryEdit | null {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return null;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return null;
  }
  const { state } = view;
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const pos = selection.from;
  const forward = event.key === 'ArrowRight';

  // The character the caret is about to step over must be link text…
  const stepOver = textNodeLinkMarkAtBoundary(
    state,
    pos,
    forward ? 'after' : 'before'
  );
  if (!stepOver) return null;
  // …and the caret must already be inside the link: either the other
  // neighbour carries the same mark, or this position is an active
  // boundary edit / stored-mark entry (covers one-character links).
  const behind = textNodeLinkMarkAtBoundary(
    state,
    pos,
    forward ? 'before' : 'after'
  );
  const inside =
    behind?.eq(stepOver) ||
    boundaryEditAt(activeEdit, pos) ||
    !!exactStoredLinkMark(state, stepOver);
  if (!inside) return null;

  // Only the landing position at the display name's edge needs a pin —
  // strictly-inside positions keep the mark through ProseMirror's
  // default marks() resolution.
  const target = forward ? pos + 1 : pos - 1;
  const boundaryMark = forward
    ? trailingBoundaryLinkMark(state, target)
    : leadingBoundaryLinkMark(state, target);
  if (!boundaryMark?.eq(stepOver)) return null;

  const tr = state.tr.setSelection(TextSelection.create(state.doc, target));
  tr.setStoredMarks(marksWithLink(state, boundaryMark));
  view.dispatch(tr);
  return { pos: target, mark: boundaryMark };
}

// Exported for tests: the boundary-editing state machine needs a real
