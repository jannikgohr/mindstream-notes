/**
 * Empty task-list items.
 *
 * GFM only recognises `- [ ] x` as a task when something follows the checkbox:
 * micromark's task-list tokenizer bails at EOF right after the `]`, so a bare
 * `- [ ]` parses as an ordinary list item whose text is the literal `[ ]`.
 * That matches how GitHub renders a *file*, and it is unusable in an editor —
 * an empty task item is the state every task passes through while it is being
 * typed:
 *
 *   - in the Source pane, `- [ ]` showed up in WYSIWYG as a bullet with the
 *     characters `[ ]` in it rather than a checkbox, and
 *   - the next doc → source resync serialized that literal text back out as
 *     `- \[ ]` (mdast escapes a leading `[` in a list item precisely so it
 *     won't be read as a checkbox), so the half-typed task was mangled into
 *     something that could never *become* a task.
 *
 * This transform closes the gap on the parse side: a list item whose first
 * paragraph is nothing but `[ ]` / `[x]` becomes a real (empty) task item.
 * With `checked` set, the serializer emits the checkbox syntax again instead
 * of escaping it, so the round-trip is stable in both directions.
 *
 * A deliberately escaped `\[ ]` is left alone. mdast unescapes text values, so
 * the marker text alone can't tell the two apart — we look at the raw source
 * offset the text node came from instead.
 */

import { $remark } from '@milkdown/kit/utils';
import { gfmTaskListItemToMarkdown } from 'mdast-util-gfm-task-list-item';

/** Minimal structural shape we need from an mdast node. */
export interface MdastNode {
  type: string;
  value?: string;
  checked?: boolean | null;
  children?: MdastNode[];
  position?: { start?: { offset?: number } };
}

/** A paragraph holding only a checkbox marker, e.g. `[ ]` or `[x]  `. */
const LONE_CHECKBOX = /^\[([ xX])\][ \t]*$/;

/**
 * Whether the marker at `offset` was written literally. `\[ ]` is an escape the
 * author asked for, and mdast has already dropped the backslash from the text
 * value, so the source is the only place the distinction survives.
 */
function isUnescaped(source: string, offset: number | undefined): boolean {
  return typeof offset === 'number' && source[offset] === '[';
}

function convertEmptyTaskItems(node: MdastNode, source: string): void {
  if (!Array.isArray(node.children)) return;
  for (const child of node.children) convertEmptyTaskItems(child, source);
  if (node.type !== 'listItem' || node.checked != null) return;

  const paragraph = node.children[0];
  if (paragraph?.type !== 'paragraph') return;
  const [text, ...rest] = paragraph.children ?? [];
  if (rest.length > 0 || text?.type !== 'text') return;

  const match = LONE_CHECKBOX.exec(text.value ?? '');
  if (!match || !isUnescaped(source, text.position?.start?.offset)) return;

  node.checked = match[1] === 'x' || match[1] === 'X';
  paragraph.children = [];
}

/**
 * The whole transform, exported (and mutating `tree` in place, mdast-transform
 * style) so it can be unit tested against hand-built trees without booting an
 * editor.
 */
export function restoreEmptyTaskItems(tree: unknown, source: string): void {
  convertEmptyTaskItems(tree as MdastNode, source);
}

/** Remark plugin: recognise `- [ ]` with no content as an empty task item. */
export const emptyTaskListItems = $remark(
  'mindstream-empty-task-list-items',
  () => () => (tree: unknown, file: unknown) => {
    restoreEmptyTaskItems(tree, String(file));
  }
);

/* --- serialize half ------------------------------------------------------- */

/** Matches a list marker with nothing after it at all — an empty item. */
const MARKER_ALONE = /^(?:[*+-]|\d+\.)$/;

const gfmTaskListItemExtension = gfmTaskListItemToMarkdown();
const gfmListItemHandler = gfmTaskListItemExtension.handlers?.listItem;

if (!gfmListItemHandler) {
  throw new Error('The GFM task-list extension has no list-item handler');
}

type TaskListItemHandler = NonNullable<
  NonNullable<typeof gfmTaskListItemExtension.handlers>['listItem']
>;

/**
 * `mdast-util-gfm-task-list-item` writes the checkbox by splicing it in behind
 * the list marker, which means it needs content after the marker to anchor to.
 * An EMPTY task item serializes to just `-`, nothing matches, and the checkbox
 * is silently dropped — the task degrades to a plain bullet.
 *
 * That is the other half of the bug {@link emptyTaskListItems} fixes on the
 * parse side, and it bites WYSIWYG on its own: GFM's `[ ] ` input rule creates
 * empty task items there too, so one would vanish the moment it was saved.
 *
 * This handler wraps the public GFM handler and only covers its missing empty
 * case. remark-stringify applies `options.handlers` after the extensions' own,
 * so this override wins without copying the dependency's implementation.
 */
export const taskListItemHandler: TaskListItemHandler = (
  node,
  parent,
  state,
  info
) => {
  const value = gfmListItemHandler(node, parent, state, info);
  const item = node as unknown as MdastNode;
  const head = item.children?.[0];
  const checkable =
    typeof item.checked === 'boolean' && head?.type === 'paragraph';

  if (checkable && MARKER_ALONE.test(value)) {
    return `${value} [${item.checked ? 'x' : ' '}]`;
  }
  return value;
};
