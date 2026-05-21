/**
 * Auto-pair brackets — a Milkdown $prose plugin that:
 *
 *   - Types the matching closer when the user types an opener: `(`, `[`, `{`.
 *     With an empty selection, the caret lands between the two; with a
 *     non-empty selection, the selection is wrapped (selection preserved).
 *   - When the user types a closer (`)`, `]`, `}`) and the very next
 *     character is already that same closer, jumps the caret past it
 *     instead of inserting a duplicate — the natural "type through the
 *     pair" feel.
 *   - When the user backspaces an opener and the matching closer sits
 *     immediately after the cursor (the freshly-inserted-pair state),
 *     deletes BOTH so one keystroke undoes one pair. Same trick with
 *     Delete and an opener directly at the cursor. Without this, the
 *     four-char `[[]]` that comes out of typing `[[` would need four
 *     backspaces to clear, all of them mismatched mid-undo.
 *
 * Suppressed inside code contexts (`code_block`, `fence`, `html_block`)
 * where literal brackets are usually intentional and a phantom closer
 * would be obnoxious. Quotes/backticks are deliberately NOT paired —
 * apostrophes-in-words and quote-as-punctuation get false positives
 * too often to be worth it for a notes app.
 */

import { Plugin } from '@milkdown/kit/prose/state';
import { TextSelection } from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';

const PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}'
};
const CLOSERS = new Set(Object.values(PAIRS));

const CODE_PARENTS = new Set(['code_block', 'fence', 'html_block']);

export const autoPair = $prose(
  () =>
    new Plugin({
      props: {
        handleTextInput(view, from, to, text) {
          if (text.length !== 1) return false;

          // Skip inside code-shaped blocks so users typing literal brackets
          // in code don't get a phantom closer they then have to delete.
          const $from = view.state.doc.resolve(from);
          if (CODE_PARENTS.has($from.parent.type.name)) return false;
          // Inline code mark: same reasoning. Resolve marks at the
          // insertion point, not the cursor — `from` is where the
          // typed char would land.
          const codeMark = view.state.schema.marks.code;
          if (codeMark && codeMark.isInSet($from.marks())) return false;

          const closer = PAIRS[text];
          if (closer) {
            const { tr } = view.state;
            if (from !== to) {
              const selected = view.state.doc.textBetween(from, to, '\n');
              tr.insertText(text + selected + closer, from, to);
              tr.setSelection(
                TextSelection.create(tr.doc, from + 1, from + 1 + selected.length)
              );
            } else {
              tr.insertText(text + closer, from);
              tr.setSelection(TextSelection.create(tr.doc, from + 1));
            }
            view.dispatch(tr);
            return true;
          }

          // Typing a closer right before that same closer → jump over it
          // instead of duplicating. Only when the selection is empty;
          // otherwise the user is replacing a selection and the normal
          // path is correct.
          if (CLOSERS.has(text) && from === to) {
            const next = view.state.doc.textBetween(from, from + 1);
            if (next === text) {
              view.dispatch(
                view.state.tr.setSelection(
                  TextSelection.create(view.state.doc, from + 1)
                )
              );
              return true;
            }
          }

          return false;
        },

        handleKeyDown(view, event) {
          if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
          if (!view.state.selection.empty) return false;

          const { from } = view.state.selection;
          const $from = view.state.doc.resolve(from);
          // Same suppression as the insertion path — pair-deletion
          // inside code would be just as obnoxious as a phantom
          // closer there. Resolved at the cursor; we already know
          // selection is empty.
          if (CODE_PARENTS.has($from.parent.type.name)) return false;
          const codeMark = view.state.schema.marks.code;
          if (codeMark && codeMark.isInSet($from.marks())) return false;

          // We deliberately read from $from.parent (with parent-relative
          // offsets) rather than the whole doc. textBetween across block
          // boundaries concatenates without a separator by default, so
          // an opener at the end of one paragraph followed by a closer
          // at the start of the next would falsely look like a pair.
          // Same-parent scoping makes that impossible.
          const parent = $from.parent;
          const offset = $from.parentOffset;

          if (event.key === 'Backspace') {
            // Need a char before the cursor (to be deleted) AND a char
            // after (the potential matching closer).
            if (offset < 1 || offset >= parent.content.size) return false;
            const before = parent.textBetween(offset - 1, offset);
            const after = parent.textBetween(offset, offset + 1);
            if (PAIRS[before] === after) {
              view.dispatch(view.state.tr.delete(from - 1, from + 1));
              return true;
            }
            return false;
          }

          // Delete: opener at the cursor + closer right after it.
          // `[abc|...` style — Delete should just remove the next char
          // normally — falls through to the default handler.
          if (offset + 2 > parent.content.size) return false;
          const at = parent.textBetween(offset, offset + 1);
          const next = parent.textBetween(offset + 1, offset + 2);
          if (PAIRS[at] === next) {
            view.dispatch(view.state.tr.delete(from, from + 2));
            return true;
          }
          return false;
        }
      }
    })
);
