/**
 * Auto-pair brackets for the source surface — the CodeMirror counterpart of
 * `../prose/auto-pair.ts`, and deliberately a re-implementation rather than a
 * call into `@codemirror/autocomplete`'s `closeBrackets()`.
 *
 * The stock extension is close but not the same: it pairs quotes (which we
 * rejected — apostrophes-in-words produce too many false positives for a notes
 * app), and it only types through a closer it inserted itself, tracked in its
 * own state field. Ours types through any matching closer. Those differences
 * are small individually and would read as the two panes behaving differently,
 * which is the one thing this whole exercise is meant to avoid. It also keeps
 * `@codemirror/autocomplete` out of the dependency list.
 *
 * Behaviour, identical to the prose plugin:
 *   - Typing an opener `(`, `[`, `{` inserts the matching closer. Empty
 *     selection → caret lands between the two; non-empty → the selection is
 *     wrapped and preserved.
 *   - Typing a closer when that same closer is already the next character
 *     jumps over it instead of duplicating.
 *   - Backspace on an opener whose closer sits immediately after the caret
 *     deletes BOTH, so one keystroke undoes one pair (without this, the
 *     `[[]]` from typing `[[` takes four backspaces). Delete does the mirror
 *     case, with an opener at the caret.
 *
 * Suppressed inside code — see `./code-context`.
 *
 * The decision logic is exported as pure functions over `EditorState` so it
 * can be tested without a DOM, matching the `../../source/source-actions.ts`
 * pattern; `sourceAutoPair` is just the wiring.
 */

import { EditorView, keymap } from '@codemirror/view';
import { EditorSelection, Prec, type Extension } from '@codemirror/state';
import type { EditorState, TransactionSpec } from '@codemirror/state';
import { inCodeContext } from './code-context';

const PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}'
};
const CLOSERS = new Set(Object.values(PAIRS));

/** The single character at `pos`, or '' at the end of the document. */
function charAt(state: EditorState, pos: number): string {
  if (pos < 0 || pos >= state.doc.length) return '';
  return state.doc.sliceString(pos, pos + 1);
}

/**
 * The transaction for typing `text` over [`from`, `to`), or null to let
 * CodeMirror insert it normally.
 */
export function autoPairInput(
  state: EditorState,
  from: number,
  to: number,
  text: string
): TransactionSpec | null {
  if (text.length !== 1) return null;
  if (inCodeContext(state, from)) return null;

  const closer = PAIRS[text];
  if (closer) {
    if (from !== to) {
      const selected = state.doc.sliceString(from, to);
      return {
        changes: { from, to, insert: text + selected + closer },
        // Selection stays over the wrapped text, shifted past the opener.
        selection: EditorSelection.range(from + 1, from + 1 + selected.length)
      };
    }
    return {
      changes: { from, insert: text + closer },
      selection: EditorSelection.cursor(from + 1)
    };
  }

  // Typing a closer directly before that same closer → step over it. Only
  // with an empty selection; otherwise the user is replacing a selection and
  // the normal insert is correct.
  if (CLOSERS.has(text) && from === to && charAt(state, from) === text) {
    return { selection: EditorSelection.cursor(from + 1) };
  }

  return null;
}

/**
 * The transaction for a Backspace (`forward: false`) or Delete
 * (`forward: true`) that should remove a whole bracket pair, or null to fall
 * through to the default deletion.
 *
 * Only fires on a single empty caret sitting exactly at a pair, which is the
 * freshly-inserted-pair state. Anything else — a selection, multiple carets,
 * a caret merely near a bracket — is ordinary editing.
 */
export function autoPairDelete(
  state: EditorState,
  forward: boolean
): TransactionSpec | null {
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return null;
  const pos = sel.main.head;
  if (inCodeContext(state, pos)) return null;

  // Unlike the prose plugin we don't need parent-relative offsets to avoid
  // reading across a block boundary: the source document is one flat string,
  // and a line break is a real character that can't match PAIRS.
  const [opener, closerPos] = forward
    ? [charAt(state, pos), pos + 1]
    : [charAt(state, pos - 1), pos];
  if (!PAIRS[opener] || PAIRS[opener] !== charAt(state, closerPos)) return null;

  return forward
    ? { changes: { from: pos, to: pos + 2 } }
    : { changes: { from: pos - 1, to: pos + 1 } };
}

/**
 * Auto-pair brackets. Register only when the `editor.autoPair` setting is on
 * — the same toggle that gates the prose plugin.
 */
export function sourceAutoPair(): Extension {
  return [
    EditorView.inputHandler.of((view, from, to, text) => {
      const spec = autoPairInput(view.state, from, to, text);
      if (!spec) return false;
      view.dispatch({ ...spec, scrollIntoView: true, userEvent: 'input.type' });
      return true;
    }),
    // Above the default keymap so our pair-aware Backspace/Delete get first
    // refusal; returning false falls through to the default single-char
    // deletion for every other case.
    Prec.high(
      keymap.of([
        {
          key: 'Backspace',
          run: (view) => {
            const spec = autoPairDelete(view.state, false);
            if (!spec) return false;
            view.dispatch({ ...spec, userEvent: 'delete.backward' });
            return true;
          }
        },
        {
          key: 'Delete',
          run: (view) => {
            const spec = autoPairDelete(view.state, true);
            if (!spec) return false;
            view.dispatch({ ...spec, userEvent: 'delete.forward' });
            return true;
          }
        }
      ])
    )
  ];
}
