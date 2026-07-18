/**
 * "Is this position inside code?" for the source surface.
 *
 * Both source plugins suppress themselves inside code, for the same reason
 * their WYSIWYG counterparts do: brackets and `@` are usually literal there,
 * so a phantom closer or an autocomplete popup is noise at best. The WYSIWYG
 * plugins answer this by checking the ProseMirror parent node type (plus the
 * `code` mark); over raw markdown there are no nodes, so we ask the Lezer
 * markdown tree that `@codemirror/lang-markdown` already maintains for
 * syntax highlighting — no extra parsing work, and it tracks fences and
 * inline spans correctly as the user types.
 *
 * `syntaxTree` returns only what has been parsed so far (CodeMirror parses
 * lazily, viewport-first). A gap would make this return false — i.e. "not
 * code" — which is the safe default: the plugin stays active rather than
 * silently dying somewhere far down a large document. In practice the cursor
 * is inside the viewport, which is exactly the parsed region.
 */

import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';

/**
 * Lezer markdown node names that mean "literal text, not markup". Covers
 * fenced (```) and indented code blocks, inline `code` spans, and raw HTML —
 * the same set the prose plugins suppress on (`code_block`, `fence`,
 * `html_block`, plus the inline `code` mark).
 */
const CODE_NODES = new Set([
  'CodeBlock',
  'CodeText',
  'CommentBlock',
  'FencedCode',
  'HTMLBlock',
  'InlineCode'
]);

/**
 * True when `pos` sits inside a code construct.
 *
 * Resolved with a leftward bias: `pos` is where a typed character would land,
 * so the context that matters is the one the character before it is in — same
 * reasoning as the prose plugins resolving marks at the insertion point rather
 * than at the cursor.
 */
export function inCodeContext(state: EditorState, pos: number): boolean {
  let node: { name: string; parent: unknown } | null = syntaxTree(
    state
  ).resolveInner(pos, -1);
  while (node) {
    if (CODE_NODES.has(node.name)) return true;
    node = node.parent as typeof node;
  }
  return false;
}
