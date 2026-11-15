import { TextSelection, type PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

export interface CaretRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export type TypeaheadState = {
  open: boolean;
  query: string;
  caretRect: CaretRect | null;
  highlight: number;
};

export function resetTypeahead(state: TypeaheadState): void {
  state.open = false;
  state.query = '';
  state.caretRect = null;
  state.highlight = 0;
}

export function syncTypeahead(
  view: EditorView,
  state: TypeaheadState,
  start: number | null,
  markerLength: number
): void {
  if (start === null) {
    if (state.open) resetTypeahead(state);
    return;
  }
  const cursor = view.state.selection.from;
  const query = view.state.doc.textBetween(start + markerLength, cursor, '\n');
  const c = view.coordsAtPos(cursor);
  if (!state.open || state.query !== query) state.highlight = 0;
  state.open = true;
  state.query = query;
  state.caretRect = {
    top: c.top,
    bottom: c.bottom,
    left: c.left,
    right: c.left,
    width: 0,
    height: c.bottom - c.top
  };
}

export function typeaheadKeys(
  event: KeyboardEvent,
  isOpen: boolean,
  state: TypeaheadState,
  close: () => void,
  commit: () => void
): boolean {
  if (!isOpen) return false;
  switch (event.key) {
    case 'Escape':
      event.preventDefault();
      close();
      return true;
    case 'Enter':
      event.preventDefault();
      commit();
      return true;
    case 'Tab':
      event.preventDefault();
      commit();
      return true;
    case 'ArrowDown':
      event.preventDefault();
      state.highlight += 1;
      return true;
    case 'ArrowUp':
      event.preventDefault();
      state.highlight = Math.max(0, state.highlight - 1);
      return true;
    default:
      return false;
  }
}

export function commitTypeahead(
  view: EditorView,
  start: number,
  replaceTo: number,
  label: string,
  href: string,
  pluginKey: PluginKey,
  close: () => void
): void {
  const linkType = view.state.schema.marks.link;
  if (!linkType) {
    const tr = view.state.tr.insertText(label, start, replaceTo);
    tr.setMeta(pluginKey, { close: true });
    view.dispatch(tr);
    view.focus();
    close();
    return;
  }
  const mark = linkType.create({ href, title: null });
  const linkText = view.state.schema.text(label, [mark]);
  const tr = view.state.tr.replaceWith(start, replaceTo, linkText);
  tr.setSelection(TextSelection.create(tr.doc, start + label.length));
  tr.setStoredMarks([]);
  tr.setMeta(pluginKey, { close: true });
  view.dispatch(tr);
  view.focus();
  close();
}
