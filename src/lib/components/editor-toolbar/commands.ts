/**
 * Toolbar item catalogue + command recipes shared by the desktop and mobile
 * editor toolbars. Pure data — no Svelte, no DOM — so both UIs can render the
 * same set of commands without duplicating recipes.
 *
 * Recipes deliberately DIVERGE from Crepe's slash-menu in one important way:
 * the slash menu starts every action with `clearTextInCurrentBlockCommand`
 * to wipe the `/whatever` the user typed to summon it. A toolbar click has
 * no such trigger text, so clearing here would silently delete the user's
 * current line. Each family has its own non-destructive recipe:
 *
 *   Text styles  (paragraph, h1–h6)
 *     Skipped inside code blocks and lists (markdown headings can't live
 *     there). Otherwise just `setBlockTypeCommand` — that's a node-type
 *     swap in ProseMirror, the text content is preserved.
 *
 *   Lists  (bullet, ordered, task)
 *     Lifts the current line out of any list it's in, then if the line
 *     isn't a plain paragraph (e.g. it's a heading) converts it. Then
 *     wraps in the target list type. Same-list-clicked toggles the line
 *     back out (lift only, no re-wrap).
 *
 *   Advanced  (image, code block, table, math)
 *     `addBlockTypeCommand` always — never `setBlockTypeCommand` — so the
 *     element appears on a fresh empty block right after the current
 *     line, and the cursor's line is never overwritten.
 */

import { commandsCtx, editorViewCtx } from '@milkdown/kit/core';
import {
  setBlockTypeCommand,
  wrapInBlockTypeCommand,
  addBlockTypeCommand,
  liftListItemCommand,
  paragraphSchema,
  headingSchema,
  bulletListSchema,
  orderedListSchema,
  listItemSchema,
  codeBlockSchema
} from '@milkdown/kit/preset/commonmark';
import { createTable } from '@milkdown/kit/preset/gfm';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import { undoCommand, redoCommand } from '@milkdown/kit/plugin/history';
import type { Ctx } from '@milkdown/kit/ctx';
import type { EditorView } from '@milkdown/kit/prose/view';
import {
  Undo2,
  Redo2,
  Type,
  Pilcrow,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  List,
  ListOrdered,
  ListTodo,
  Sparkles,
  Image as ImageIcon,
  Code,
  Table as TableIcon,
  Sigma
} from 'lucide-svelte';
import type { ComponentType } from 'svelte';

export interface ToolbarLeaf {
  kind: 'leaf';
  id: string;
  labelKey: string;
  icon: ComponentType;
  action: (ctx: Ctx) => void;
}

export interface ToolbarGroup {
  kind: 'group';
  id: string;
  labelKey: string;
  icon: ComponentType;
  items: ToolbarLeaf[];
}

export type ToolbarItem = ToolbarLeaf | ToolbarGroup;

// -- Context helpers ---------------------------------------------------------

/** True when the caret sits inside a code block or any list — places where
 *  changing to a heading would be semantically wrong (CommonMark headings
 *  can't be nested in code or lists). */
function isInCodeOrList(view: EditorView): boolean {
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

/** Identify what kind of list (if any) the caret currently lives in. Task
 *  lists are bullet lists whose list_items carry a non-null `checked`
 *  attribute (Crepe's gfm task-list-item extension). */
type ListKind = 'bullet' | 'ordered' | 'task';
function detectListKind(view: EditorView): ListKind | null {
  const { $from } = view.state.selection;
  let parentList: string | null = null;
  let listItemChecked: unknown = undefined;
  for (let d = $from.depth; d >= 0; d--) {
    const node = $from.node(d);
    const name = node.type.name;
    if (name === 'bullet_list' || name === 'ordered_list') {
      parentList = name;
    } else if (name === 'list_item') {
      listItemChecked = node.attrs.checked;
    }
  }
  if (!parentList) return null;
  if (parentList === 'ordered_list') return 'ordered';
  // bullet_list with a checked list_item → task list
  if (listItemChecked !== null && listItemChecked !== undefined) return 'task';
  return 'bullet';
}

/** Walk out of the current list one level at a time until the caret is no
 *  longer inside any list. Bounded by `maxLifts` so a malformed document
 *  can't trap us in an infinite loop. */
function liftOutOfList(ctx: Ctx, view: EditorView, maxLifts = 8): void {
  const commands = ctx.get(commandsCtx);
  for (let i = 0; i < maxLifts; i++) {
    if (detectListKind(view) === null) return;
    const before = view.state.selection.$from.depth;
    commands.call(liftListItemCommand.key);
    const after = view.state.selection.$from.depth;
    // If the lift didn't reduce depth, we're stuck — bail.
    if (after >= before) return;
  }
}

// -- Action helpers ----------------------------------------------------------

const undo = (ctx: Ctx) => {
  ctx.get(commandsCtx).call(undoCommand.key);
};
const redo = (ctx: Ctx) => {
  ctx.get(commandsCtx).call(redoCommand.key);
};

const turnIntoParagraph = (ctx: Ctx) => {
  const view = ctx.get(editorViewCtx);
  if (isInCodeOrList(view)) return;
  ctx.get(commandsCtx).call(setBlockTypeCommand.key, {
    nodeType: paragraphSchema.type(ctx)
  });
};
const turnIntoHeading = (level: number) => (ctx: Ctx) => {
  const view = ctx.get(editorViewCtx);
  if (isInCodeOrList(view)) return;
  ctx.get(commandsCtx).call(setBlockTypeCommand.key, {
    nodeType: headingSchema.type(ctx),
    attrs: { level }
  });
};

/**
 * Switch the current line into (or out of) the given list kind.
 *   - same kind clicked again → toggle off (lift back to paragraph)
 *   - different list kind     → lift out of the current list, then wrap
 *   - non-paragraph block     → convert to paragraph first, then wrap
 *   - inside a code block     → no-op
 *
 * Read state from `view` *after* each command call because each call may
 * mutate it (lift changes depth, setBlockType changes parent type, etc.).
 */
function switchListAction(target: ListKind) {
  return (ctx: Ctx) => {
    const view = ctx.get(editorViewCtx);
    const commands = ctx.get(commandsCtx);

    // Code blocks aren't valid list ancestors — skip silently rather than
    // mangling the user's code.
    const { $from } = view.state.selection;
    for (let d = $from.depth; d >= 0; d--) {
      if ($from.node(d).type.name === 'code_block') return;
    }

    const current = detectListKind(view);

    if (current === target) {
      // Same kind toggles off.
      liftOutOfList(ctx, view);
      return;
    }

    // Different list (or no list): get the caret out of any current list
    // first so the wrap below operates on a plain paragraph.
    if (current !== null) liftOutOfList(ctx, view);

    // After lifting we're on whatever block the list_item contained — usually
    // a paragraph, but headings inside list_items are valid CommonMark.
    // Lists wrap text content, so coerce non-paragraphs (e.g. heading) into
    // paragraph form before wrapping.
    if (view.state.selection.$from.parent.type.name !== 'paragraph') {
      commands.call(setBlockTypeCommand.key, {
        nodeType: paragraphSchema.type(ctx)
      });
    }

    if (target === 'bullet') {
      commands.call(wrapInBlockTypeCommand.key, {
        nodeType: bulletListSchema.type(ctx)
      });
    } else if (target === 'ordered') {
      commands.call(wrapInBlockTypeCommand.key, {
        nodeType: orderedListSchema.type(ctx)
      });
    } else {
      // Task: wrap in list_item directly with a `checked` attr — ProseMirror's
      // `findWrapping` auto-inserts the surrounding bullet_list because
      // list_item can only live there.
      commands.call(wrapInBlockTypeCommand.key, {
        nodeType: listItemSchema.type(ctx),
        attrs: { checked: false }
      });
    }
  };
}

const turnIntoBulletList = switchListAction('bullet');
const turnIntoOrderedList = switchListAction('ordered');
const turnIntoTaskList = switchListAction('task');

// Advanced actions all use `addBlockTypeCommand`, which inserts a fresh
// empty block after the current line (rather than overwriting it). The
// cursor's existing content is preserved on its own line.
const insertImageBlock = (ctx: Ctx) => {
  ctx.get(commandsCtx).call(addBlockTypeCommand.key, {
    nodeType: imageBlockSchema.type(ctx)
  });
};
const insertCodeBlock = (ctx: Ctx) => {
  ctx.get(commandsCtx).call(addBlockTypeCommand.key, {
    nodeType: codeBlockSchema.type(ctx)
  });
};
const insertTable = (ctx: Ctx) => {
  ctx.get(commandsCtx).call(addBlockTypeCommand.key, {
    nodeType: createTable(ctx, 3, 3)
  });
};
const insertMath = (ctx: Ctx) => {
  // Crepe's Latex feature renders math as a code block whose `language`
  // attribute is "LaTeX" — same recipe Crepe uses for its slash-menu math
  // item, but via `addBlockTypeCommand` so the math sits on its own new
  // line instead of overwriting the cursor's line.
  ctx.get(commandsCtx).call(addBlockTypeCommand.key, {
    nodeType: codeBlockSchema.type(ctx),
    attrs: { language: 'LaTeX' }
  });
};

// -- Catalogue ---------------------------------------------------------------

export const TOOLBAR_ITEMS: ToolbarItem[] = [
  { kind: 'leaf',  id: 'undo', labelKey: 'editor.toolbar.undo', icon: Undo2, action: undo },
  { kind: 'leaf',  id: 'redo', labelKey: 'editor.toolbar.redo', icon: Redo2, action: redo },
  {
    kind: 'group',
    id: 'text',
    labelKey: 'editor.toolbar.text.group',
    icon: Type,
    items: [
      { kind: 'leaf', id: 'p',  labelKey: 'editor.toolbar.text.normal', icon: Pilcrow,  action: turnIntoParagraph },
      { kind: 'leaf', id: 'h1', labelKey: 'editor.toolbar.text.h1',     icon: Heading1, action: turnIntoHeading(1) },
      { kind: 'leaf', id: 'h2', labelKey: 'editor.toolbar.text.h2',     icon: Heading2, action: turnIntoHeading(2) },
      { kind: 'leaf', id: 'h3', labelKey: 'editor.toolbar.text.h3',     icon: Heading3, action: turnIntoHeading(3) },
      { kind: 'leaf', id: 'h4', labelKey: 'editor.toolbar.text.h4',     icon: Heading4, action: turnIntoHeading(4) },
      { kind: 'leaf', id: 'h5', labelKey: 'editor.toolbar.text.h5',     icon: Heading5, action: turnIntoHeading(5) },
      { kind: 'leaf', id: 'h6', labelKey: 'editor.toolbar.text.h6',     icon: Heading6, action: turnIntoHeading(6) }
    ]
  },
  {
    kind: 'group',
    id: 'list',
    labelKey: 'editor.toolbar.list.group',
    icon: List,
    items: [
      { kind: 'leaf', id: 'bullet',  labelKey: 'editor.toolbar.list.bullet',  icon: List,        action: turnIntoBulletList },
      { kind: 'leaf', id: 'ordered', labelKey: 'editor.toolbar.list.ordered', icon: ListOrdered, action: turnIntoOrderedList },
      { kind: 'leaf', id: 'task',    labelKey: 'editor.toolbar.list.task',    icon: ListTodo,    action: turnIntoTaskList }
    ]
  },
  {
    kind: 'group',
    id: 'advanced',
    labelKey: 'editor.toolbar.advanced.group',
    icon: Sparkles,
    items: [
      { kind: 'leaf', id: 'image', labelKey: 'editor.toolbar.advanced.image', icon: ImageIcon, action: insertImageBlock },
      { kind: 'leaf', id: 'code',  labelKey: 'editor.toolbar.advanced.code',  icon: Code,      action: insertCodeBlock },
      { kind: 'leaf', id: 'table', labelKey: 'editor.toolbar.advanced.table', icon: TableIcon, action: insertTable },
      { kind: 'leaf', id: 'math',  labelKey: 'editor.toolbar.advanced.math',  icon: Sigma,     action: insertMath }
    ]
  }
];
