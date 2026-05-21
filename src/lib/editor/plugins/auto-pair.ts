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
        }
      }
    })
);
