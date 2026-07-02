import type { Ctx } from '@milkdown/kit/ctx';
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core';
import {
  setBlockTypeCommand,
  paragraphSchema,
  headingSchema,
  bulletListSchema,
  orderedListSchema,
  listItemSchema,
  codeBlockSchema,
  strongSchema,
  emphasisSchema
} from '@milkdown/kit/preset/commonmark';
import { toggleMark } from '@milkdown/kit/prose/commands';
import {
  redo as proseRedo,
  undo as proseUndo
} from '@milkdown/kit/prose/history';
import { APP_REDO_COMMAND, APP_UNDO_COMMAND } from './bus.svelte';
import {
  applyListAction,
  insertImageBlock,
  insertMath,
  insertMermaid,
  insertTable
} from '$lib/components/editor-toolbar/commands';

/* --- Markdown actions ------------------------------------------------------
 *
 * These are the body of the markdown editor's `dispatch(id)` entries.
 * Pulled out as named functions (not as the toolbar's `TOOLBAR_ITEMS`
 * action references) so:
 *
 *   - the hotkey manager doesn't depend on the toolbar's catalogue
 *     ordering staying stable,
 *   - adding a hotkey-only command (no toolbar button) doesn't require
 *     adding a fake toolbar row.
 *
 * Behaviour matches the toolbar recipes — those are the
 * non-destructive forms documented at the top of editor-toolbar/
 * commands.ts. We deliberately call `setBlockTypeCommand` for headings
 * (which leaves the cursor's text alone) instead of Crepe's slash-menu
 * recipes (which start by wiping the current line).
 */

const undo = (ctx: Ctx) => {
  const view = ctx.get(editorViewCtx);
  proseUndo(view.state, view.dispatch, view);
  view.focus();
};
const redo = (ctx: Ctx) => {
  const view = ctx.get(editorViewCtx);
  proseRedo(view.state, view.dispatch, view);
  view.focus();
};
const toggleBold = (ctx: Ctx) => {
  const view = ctx.get(editorViewCtx);
  toggleMark(strongSchema.type(ctx))(view.state, view.dispatch, view);
  view.focus();
};
const toggleItalic = (ctx: Ctx) => {
  const view = ctx.get(editorViewCtx);
  toggleMark(emphasisSchema.type(ctx))(view.state, view.dispatch, view);
  view.focus();
};

/** Headings and paragraph: skipped inside code/lists, same gate the
 *  toolbar uses. We don't fail silently — we just no-op, because a
 *  keyboard shortcut firing inside a code block should not corrupt the
 *  doc nor surprise the user with a heading. */
function isInCodeOrList(ctx: Ctx): boolean {
  const view = ctx.get(editorViewCtx);
  const { $from } = view.state.selection;
  for (let d = $from.depth; d >= 0; d--) {
    const name = $from.node(d).type.name;
    if (
      name === 'code_block' ||
      name === 'bullet_list' ||
      name === 'ordered_list' ||
      name === 'list_item'
    ) {
      return true;
    }
  }
  return false;
}

const turnIntoParagraph = (ctx: Ctx) => {
  if (isInCodeOrList(ctx)) return;
  ctx.get(commandsCtx).call(setBlockTypeCommand.key, {
    nodeType: paragraphSchema.type(ctx)
  });
};
const turnIntoHeading = (level: number) => (ctx: Ctx) => {
  if (isInCodeOrList(ctx)) return;
  ctx.get(commandsCtx).call(setBlockTypeCommand.key, {
    nodeType: headingSchema.type(ctx),
    attrs: { level }
  });
};

/** List toggles reuse the shared `applyListAction` helper so the
 *  hotkey path produces identical behaviour to the toolbar buttons
 *  (mixed-selection unify, partial-unlist splits, item renumbering).
 *  Reimplementing the algorithm here would have been a guaranteed
 *  divergence over time. */
function switchListAction(target: 'bullet' | 'ordered' | 'task') {
  return (ctx: Ctx) => {
    const view = ctx.get(editorViewCtx);
    applyListAction(view.state, view.dispatch.bind(view), target, {
      bulletList: bulletListSchema.type(ctx),
      orderedList: orderedListSchema.type(ctx),
      listItem: listItemSchema.type(ctx),
      paragraph: paragraphSchema.type(ctx)
    });
  };
}

const turnIntoCodeBlock = (ctx: Ctx) => {
  // Same recipe Crepe's keymap uses for ```. `setBlockTypeCommand`
  // keeps the current text in the converted block instead of inserting
  // a new empty one — same as the toolbar's behaviour-matched recipe.
  ctx.get(commandsCtx).call(setBlockTypeCommand.key, {
    nodeType: codeBlockSchema.type(ctx)
  });
};

/**
 * Lookup table for the markdown editor adapter: hotkey command id →
 * the milkdown ctx callback that performs it. Kept in this file (not
 * in NoteEditor.svelte) so the catalogue and the dispatch table are
 * authored together and can't drift.
 */
export const MARKDOWN_ACTIONS: Record<string, (ctx: Ctx) => void> = {
  [APP_UNDO_COMMAND]: undo,
  [APP_REDO_COMMAND]: redo,
  'editor.markdown.undo': undo,
  'editor.markdown.redo': redo,
  'editor.markdown.bold': toggleBold,
  'editor.markdown.italic': toggleItalic,
  'editor.markdown.paragraph': turnIntoParagraph,
  'editor.markdown.h1': turnIntoHeading(1),
  'editor.markdown.h2': turnIntoHeading(2),
  'editor.markdown.h3': turnIntoHeading(3),
  'editor.markdown.h4': turnIntoHeading(4),
  'editor.markdown.h5': turnIntoHeading(5),
  'editor.markdown.h6': turnIntoHeading(6),
  'editor.markdown.bulletList': switchListAction('bullet'),
  'editor.markdown.orderedList': switchListAction('ordered'),
  'editor.markdown.taskList': switchListAction('task'),
  'editor.markdown.imageBlock': insertImageBlock,
  'editor.markdown.codeBlock': turnIntoCodeBlock,
  'editor.markdown.table': insertTable,
  'editor.markdown.math': insertMath,
  'editor.markdown.mermaidDiagram': insertMermaid
};
