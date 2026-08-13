import type { EditorView } from '@codemirror/view';
import type { PluginSourceEditAction } from '$lib/plugins/types';

function clampOffset(offset: unknown, fallback: number, max: number): number {
  if (typeof offset !== 'number' || !Number.isFinite(offset)) return fallback;
  return Math.min(Math.max(Math.trunc(offset), 0), max);
}

export function applyPluginSourceEdit(
  view: EditorView,
  action: PluginSourceEditAction
): void {
  const selection = view.state.selection.main;
  const selected = view.state.doc.sliceString(selection.from, selection.to);

  if (action.type === 'insertText') {
    const cursor = clampOffset(
      action.cursorOffset,
      action.text.length,
      action.text.length
    );
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: action.text },
      selection: { anchor: selection.from + cursor }
    });
    view.focus();
    return;
  }

  const placeholder = selected || action.placeholder || '';
  const insert = action.before + placeholder + action.after;
  const innerStart = selection.from + action.before.length;
  const innerEnd = innerStart + placeholder.length;
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: { anchor: innerStart, head: innerEnd }
  });
  view.focus();
}
