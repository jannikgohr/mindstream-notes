/**
 * Insert a markdown snippet at the cursor of a live Milkdown editor.
 *
 * Unlike the seed path (`seed-template.ts`), which stamps a *whole empty*
 * document's fragment with a deterministic origin, this inserts into whatever
 * the user is currently editing — replacing the selection with the parsed
 * block(s). Used by the command palette's "Insert template into note" action:
 * a template's rendered body drops in wherever the caret sits.
 *
 * Parses the markdown into a ProseMirror doc node via the same `getDoc`
 * helper the seed path uses, then replaces the current selection with the
 * node's content as a slice (open depths 0 → the blocks land as siblings, the
 * caret's empty paragraph is consumed as expected). A no-op when the markdown
 * parses to nothing.
 */

import {
  editorViewCtx,
  getDoc,
  parserCtx,
  schemaCtx
} from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';

/** Milkdown action: parse `markdown` and insert it at the current selection. */
export function insertMarkdownAtSelection(ctx: Ctx, markdown: string): void {
  const view = ctx.get(editorViewCtx);
  const node = getDoc(markdown, ctx.get(parserCtx), ctx.get(schemaCtx));
  if (!node || node.content.size === 0) return;
  const tr = view.state.tr.replaceSelection(node.slice(0));
  view.dispatch(tr);
  view.focus();
}
