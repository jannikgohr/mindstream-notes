/**
 * Symmetric blank-line round-tripping.
 *
 * Markdown has no node for "an empty paragraph", so a run of blank lines the
 * user typed in the Source pane normally parses to nothing and the matching
 * vertical space in WYSIWYG disappears. Milkdown's own answer was to serialize
 * an empty paragraph to a literal `<br />` and strip that html node on parse —
 * which smuggles HTML into the document and (with an editable source view)
 * caused `<br />` to reappear every time it was deleted. We dropped that plugin
 * in `crepe-setup.ts`.
 *
 * This is the honest version: use the blank lines themselves as the
 * representation, with an exact 1:1 mapping in both directions —
 *
 *   k empty paragraphs  <->  (k + 1) blank lines
 *
 * i.e. one blank line is the ordinary block separator (k = 0), two blank lines
 * mean one empty paragraph, three mean two, and so on.
 *
 * This module is the PARSE half: remark gives us no nodes for blank lines, but
 * it does give every node a source `position`, so the gap between two siblings
 * tells us how many blank lines were between them. The SERIALIZE half is the
 * `join` hook in `crepe-setup.ts`, which suppresses the separator blank line
 * after an empty paragraph so k of them emit exactly k + 1 blank lines.
 */

import { $remark } from '@milkdown/kit/utils';

/** Minimal structural shape we need from an mdast node. */
export interface MdastNode {
  type: string;
  children?: MdastNode[];
  position?: {
    start?: { line?: number };
    end?: { line?: number };
  };
}

/**
 * Containers whose children are flow (block) content, so a blank-line gap
 * between two of them is meaningful. `list` is deliberately excluded: a gap
 * between its `listItem`s encodes loose-vs-tight, not empty paragraphs.
 */
const FLOW_CONTAINERS = new Set(['root', 'blockquote', 'listItem']);

export function isEmptyParagraph(node: unknown): boolean {
  const n = node as MdastNode | null | undefined;
  return n?.type === 'paragraph' && (!n.children || n.children.length === 0);
}

/** Number of blank lines between two siblings, from their source positions.
 *  Falls back to 1 (the ordinary separator) when positions are missing — e.g.
 *  for nodes another transform synthesised. */
function blankLineGap(left: MdastNode, right: MdastNode): number {
  const end = left.position?.end?.line;
  const start = right.position?.start?.line;
  if (typeof end !== 'number' || typeof start !== 'number') return 1;
  return Math.max(start - end - 1, 0);
}

function restoreBlankLines(node: MdastNode): void {
  if (!Array.isArray(node.children)) return;
  for (const child of node.children) restoreBlankLines(child);
  if (!FLOW_CONTAINERS.has(node.type)) return;

  const original = node.children;
  const out: MdastNode[] = [];
  for (let i = 0; i < original.length; i++) {
    if (i > 0) {
      // gap blank lines → (gap - 1) empty paragraphs; gap <= 1 is the plain
      // block separator and contributes none.
      const gap = blankLineGap(original[i - 1], original[i]);
      for (let n = 1; n < gap; n++)
        out.push({ type: 'paragraph', children: [] });
    }
    out.push(original[i]);
  }
  node.children = out;
}

/**
 * Trailing blank lines have no following sibling, so `restoreBlankLines` can't
 * see them — the gap is only visible in the raw source. Read it off the text:
 * one trailing newline is the ordinary end-of-file, and every extra one is an
 * empty paragraph, keeping the same k <-> k + 1 mapping used between blocks.
 * Without this, empty lines added at the END of a document are dropped on the
 * next round-trip.
 */
function restoreTrailingBlankLines(root: MdastNode, text: string): void {
  if (!Array.isArray(root.children) || root.children.length === 0) return;
  const trailingNewlines = /\n*$/.exec(text)?.[0].length ?? 0;
  const count = Math.max(trailingNewlines - 1, 0);
  for (let n = 0; n < count; n++) {
    root.children.push({ type: 'paragraph', children: [] });
  }
}

/**
 * The whole parse-side transform: rebuild empty paragraphs from blank-line runs
 * between siblings AND from the trailing run at the end of `text`. Exported
 * (and mutating `tree` in place, mdast-transform style) so it can be unit
 * tested against hand-built trees without booting an editor.
 */
export function restoreEmptyParagraphs(tree: MdastNode, text: string): void {
  restoreBlankLines(tree);
  restoreTrailingBlankLines(tree, text);
}

/** Remark plugin: rebuild empty paragraphs from runs of blank lines. Runs on
 *  parse (Milkdown calls `remark.runSync(tree, markdown)`, so `file`
 *  stringifies back to the original source). */
export const preserveBlankLines = $remark(
  'mindstream-preserve-blank-lines',
  () => () => (tree: unknown, file: unknown) => {
    restoreEmptyParagraphs(tree as MdastNode, String(file));
  }
);
