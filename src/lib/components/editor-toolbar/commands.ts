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

import { commandsCtx, editorStateCtx, editorViewCtx } from '@milkdown/kit/core';
import {
  setBlockTypeCommand,
  addBlockTypeCommand,
  liftListItemCommand,
  paragraphSchema,
  headingSchema,
  bulletListSchema,
  orderedListSchema,
  listItemSchema,
  codeBlockSchema,
  strongSchema,
  emphasisSchema,
  toggleStrongCommand,
  toggleEmphasisCommand
} from '@milkdown/kit/preset/commonmark';
import { createTable } from '@milkdown/kit/preset/gfm';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import { undoCommand, redoCommand } from '@milkdown/kit/plugin/history';
import { wrapInList } from '@milkdown/kit/prose/schema-list';
import type { Ctx } from '@milkdown/kit/ctx';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { EditorState } from '@milkdown/kit/prose/state';
import type { MarkType, ResolvedPos } from '@milkdown/kit/prose/model';
import {
  Undo2,
  Redo2,
  Bold,
  Italic,
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
  /**
   * Optional predicate: true means the button should render in its
   * "toggled" state. Used for bold/italic so the icon stays highlighted
   * while the mark is in effect — including the empty-selection case
   * where the user has just clicked the button and will continue typing
   * inside the open mark. The toolbar re-evaluates this on every
   * editor transaction (via the listener plugin) plus immediately
   * after the toolbar itself dispatches an action, so toggling a mark
   * with no selection (which only mutates `state.storedMarks` — not
   * doc, not selection — and therefore won't fire any listener) still
   * updates the button visual.
   */
  isActive?: (ctx: Ctx) => boolean;
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

/** Identify what kind of list (if any) the textblock at $pos lives in.
 *  Walks ancestors innermost-first so for nested lists we report the
 *  immediate enclosing list — that's the one a user-facing toggle
 *  should reason about. Task lists are bullet lists whose list_items
 *  carry a non-null `checked` attribute (Crepe's gfm task-list-item
 *  extension). */
type ListKind = 'bullet' | 'ordered' | 'task';
function detectListKindAt($pos: ResolvedPos): ListKind | null {
  let parentList: string | null = null;
  let foundListItem = false;
  let listItemChecked: unknown = null;
  for (let d = $pos.depth; d >= 0; d--) {
    const name = $pos.node(d).type.name;
    if (parentList === null && (name === 'bullet_list' || name === 'ordered_list')) {
      parentList = name;
    }
    if (!foundListItem && name === 'list_item') {
      foundListItem = true;
      listItemChecked = $pos.node(d).attrs.checked;
    }
  }
  if (!parentList) return null;
  if (parentList === 'ordered_list') return 'ordered';
  if (listItemChecked !== null && listItemChecked !== undefined) return 'task';
  return 'bullet';
}

/** Collect the list-kind of every top-level textblock contained in `[from, to]`.
 *  Returns `null` entries for blocks that aren't in any list. Also flags
 *  whether the range crosses a code block (lists can't wrap code, so we
 *  bail out of the list action in that case). */
function inspectSelectionBlocks(
  state: EditorState
): { blocks: (ListKind | null)[]; hasCodeBlock: boolean } {
  const { from, to } = state.selection;
  const blocks: (ListKind | null)[] = [];
  let hasCodeBlock = false;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'code_block') {
      hasCodeBlock = true;
      return false;
    }
    if (node.isTextblock) {
      blocks.push(detectListKindAt(state.doc.resolve(pos)));
      // Don't descend into the textblock — its inline children aren't
      // separate "lines".
      return false;
    }
    return true;
  });
  return { blocks, hasCodeBlock };
}

/** Are any textblocks in the current selection still inside a list? Used
 *  to drive the multi-call lift loop below — we keep calling
 *  liftListItemCommand until this returns false. */
function selectionTouchesAnyList(view: EditorView): boolean {
  const { state } = view;
  const { from, to } = state.selection;
  let touched = false;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) {
      if (detectListKindAt(state.doc.resolve(pos)) !== null) {
        touched = true;
        return false;
      }
    }
    return !touched;
  });
  return touched;
}

/** Lift everything in the current selection out of whatever list(s) it
 *  sits in. `liftListItemCommand` only lifts one level per call, and on
 *  a multi-line selection it can sometimes only lift part of the range
 *  in one shot — so we loop, bounded, until no selected block has any
 *  list ancestor (or the doc stops changing). */
function liftSelectionOutOfList(
  ctx: Ctx,
  view: EditorView,
  maxAttempts = 16
): void {
  const commands = ctx.get(commandsCtx);
  for (let i = 0; i < maxAttempts; i++) {
    if (!selectionTouchesAnyList(view)) return;
    const beforeDoc = view.state.doc;
    commands.call(liftListItemCommand.key);
    // Bail if the command was a no-op — prevents an infinite loop on a
    // pathological doc where lifting "succeeds" without actually moving
    // anything.
    if (view.state.doc === beforeDoc) return;
  }
}

/**
 * "Is this mark active in the current selection?" — the standard
 * ProseMirror predicate. For a non-empty selection the mark is active
 * when present across the whole range; for an empty selection it's
 * active when in `storedMarks` (mark queued for the next typed
 * character) or among the marks at the cursor position. That second
 * case is what lets the toolbar Bold/Italic icon stay toggled while
 * the user is mid-bolded-word OR has just clicked Bold and is about
 * to start typing inside the open mark.
 */
function markIsActive(state: EditorState, type: MarkType): boolean {
  const { from, to, empty, $from } = state.selection;
  if (empty) {
    return !!type.isInSet(state.storedMarks ?? $from.marks());
  }
  return state.doc.rangeHasMark(from, to, type);
}

// -- Action helpers ----------------------------------------------------------

const undo = (ctx: Ctx) => {
  ctx.get(commandsCtx).call(undoCommand.key);
};
const redo = (ctx: Ctx) => {
  ctx.get(commandsCtx).call(redoCommand.key);
};

const toggleBold = (ctx: Ctx) => {
  ctx.get(commandsCtx).call(toggleStrongCommand.key);
};
const toggleItalic = (ctx: Ctx) => {
  ctx.get(commandsCtx).call(toggleEmphasisCommand.key);
};
const isBoldActive = (ctx: Ctx) =>
  markIsActive(ctx.get(editorStateCtx), strongSchema.type(ctx));
const isItalicActive = (ctx: Ctx) =>
  markIsActive(ctx.get(editorStateCtx), emphasisSchema.type(ctx));

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
 * Switch every selected line into (or out of) the given list kind.
 *
 * Decision is over the *whole selection*, not just the cursor:
 *   - Every selected textblock already exactly matches `target`
 *     → toggle off (lift everything out, like clicking Bullet on an
 *       all-bullet selection).
 *   - Otherwise (mix of list kinds, or some-in-some-out, or all-non-list)
 *     → unify to `target`: lift any list_items out, coerce headings
 *       back to paragraphs, then wrap the selection in a single list of
 *       the target type.
 *   - Selection touches a code block → no-op (CommonMark lists can't
 *     wrap code blocks; we'd rather skip than corrupt the user's code).
 *
 * The single-line case falls out naturally: `nodesBetween(from, to)`
 * for an empty selection still yields the cursor's textblock, so
 * blocks.length === 1 and the same logic applies.
 *
 * Re-read state from `view` after every command call because each one
 * may mutate it (lift shrinks depth, setBlockType changes parent type,
 * wrap moves positions).
 */
function switchListAction(target: ListKind) {
  return (ctx: Ctx) => {
    const view = ctx.get(editorViewCtx);
    const commands = ctx.get(commandsCtx);

    const { blocks, hasCodeBlock } = inspectSelectionBlocks(view.state);
    if (hasCodeBlock || blocks.length === 0) return;

    const allMatchTarget = blocks.every((k) => k === target);

    if (allMatchTarget) {
      // Selection is uniformly the target kind — toggle the list off.
      liftSelectionOutOfList(ctx, view);
      return;
    }

    // Mixed (or wrong kind, or not in a list): unify to the target.
    // Step 1: get every selected list_item out of its list. Safe to call
    // even when nothing is in a list — it short-circuits on the first
    // check.
    liftSelectionOutOfList(ctx, view);

    // Step 2: coerce any heading/etc. in the selection to a paragraph.
    // ProseMirror's setBlockType applies across all textblocks in the
    // selection, and is a no-op on blocks that already match — so a
    // single call here normalises a mixed selection.
    commands.call(setBlockTypeCommand.key, {
      nodeType: paragraphSchema.type(ctx)
    });

    // Step 3: wrap each selected paragraph in its own list_item, all
    // under a single new list. We use `wrapInList` from
    // prosemirror-schema-list (NOT Milkdown's wrapInBulletListCommand,
    // which delegates to plain `wrapIn` and so groups all paragraphs
    // into a single list_item — the bug that produced "* one\ntwo\nthree"
    // instead of three separate bullets). wrapInList specifically splits
    // each block via `tr.split` after the initial wrap, giving us one
    // list_item per paragraph.
    wrapSelectionInList(ctx, view, target);
  };
}

/**
 * Wrap the current selection in a list of the given kind, producing one
 * list_item per selected block. For task lists the list_items also get
 * `checked: false` — wrapInList only puts attrs on the outer list, so we
 * walk the freshly-created list_items in a second transaction and set
 * the attr there. Re-reads `view.state` after the first dispatch because
 * the wrap shifts positions.
 */
function wrapSelectionInList(ctx: Ctx, view: EditorView, target: ListKind): void {
  const listType =
    target === 'ordered'
      ? orderedListSchema.type(ctx)
      : bulletListSchema.type(ctx);
  const ok = wrapInList(listType)(view.state, view.dispatch);
  if (!ok) return;

  if (target !== 'task') return;

  // Task lists are bullet_list with `checked` on each list_item — set
  // that now on every list_item the wrap created inside the selection.
  const state = view.state;
  const { from, to } = state.selection;
  const listItemType = listItemSchema.type(ctx);
  const tr = state.tr;
  let touched = false;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === listItemType) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false });
      touched = true;
      // Don't recurse into nested lists — the toggle only applies to
      // the items at the level we just created.
      return false;
    }
    return true;
  });
  if (touched) view.dispatch(tr);
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
  { kind: 'leaf',  id: 'undo',   labelKey: 'editor.toolbar.undo',   icon: Undo2,  action: undo },
  { kind: 'leaf',  id: 'redo',   labelKey: 'editor.toolbar.redo',   icon: Redo2,  action: redo },
  { kind: 'leaf',  id: 'bold',   labelKey: 'editor.toolbar.bold',   icon: Bold,   action: toggleBold,   isActive: isBoldActive },
  { kind: 'leaf',  id: 'italic', labelKey: 'editor.toolbar.italic', icon: Italic, action: toggleItalic, isActive: isItalicActive },
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
