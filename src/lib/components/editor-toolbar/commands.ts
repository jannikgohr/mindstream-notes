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
import { Fragment } from '@milkdown/kit/prose/model';
import type { Ctx } from '@milkdown/kit/ctx';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { EditorState, Transaction } from '@milkdown/kit/prose/state';
import type {
  MarkType,
  Node as ProseNode,
  NodeType,
  ResolvedPos
} from '@milkdown/kit/prose/model';
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
  Sigma,
  Workflow
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
  /**
   * Optional setting id that gates whether this item is shown at all.
   * Read via `getSettingValue(gate)`; a falsy value (false / null /
   * undefined) drops the leaf from the rendered toolbar. The check is
   * reactive — flipping the setting in the dialog adds/removes the
   * button without remounting the editor (unlike the slash menu, which
   * is baked into Crepe at construct time).
   */
  gate?: string;
  /**
   * Optional hotkey command id (from `$lib/hotkeys`). When set, the
   * toolbar surfaces the user's current binding in the button's
   * tooltip / menu row so the shortcut is discoverable next to the
   * action. Omitted on items that have no keyboard equivalent (image,
   * table, math, mermaid) — those just show their label.
   */
  hotkeyId?: string;
}

export interface ToolbarGroup {
  kind: 'group';
  id: string;
  labelKey: string;
  icon: ComponentType;
  items: ToolbarLeaf[];
  /**
   * Same semantics as `ToolbarLeaf.gate` but for the whole group. A
   * group with all its items gated off is hidden automatically — this
   * is only for explicitly hiding a group while keeping its items'
   * gates independent.
   */
  gate?: string;
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
    if (
      parentList === null &&
      (name === 'bullet_list' || name === 'ordered_list')
    ) {
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
function inspectSelectionBlocks(state: EditorState): {
  blocks: (ListKind | null)[];
  hasCodeBlock: boolean;
} {
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

export interface ListActionTypes {
  bulletList: NodeType;
  orderedList: NodeType;
  listItem: NodeType;
  paragraph: NodeType;
}

/**
 * Apply a list toggle across whatever the selection spans — single line,
 * a block of paragraphs, a partial range within a list, or even a range
 * that crosses several separate lists of different kinds.
 *
 * Strategy is to walk every top-level doc child the selection overlaps and
 * transform each in a single transaction. Processing is in reverse doc
 * order so earlier positions stay valid as later children resize.
 *
 *   - All selected textblocks already match `target`
 *       → toggle off. For each list child, the items in selection are
 *         replaced by their paragraph content; items outside selection
 *         remain wrapped in lists of the same original type (so a
 *         partial unlist splits the list around the kept items). Plain
 *         paragraphs outside any list are left alone.
 *
 *   - Otherwise (mixed kinds, wrong kind, or some-paragraphs / some-lists)
 *       → unify to target. For each list child, the list's node type is
 *         flipped to the target type via setNodeMarkup (no content
 *         changes, positions stay stable), and each list_item in
 *         selection gets `checked` set to `false` for task / cleared
 *         to `null` for bullet|ordered. For each non-list textblock
 *         child in selection, the block is re-emitted as a fresh
 *         list_item inside a new list of the target type (headings get
 *         coerced to paragraphs in the process).
 *
 *   - Selection touches a code block → no-op (CommonMark lists can't
 *     wrap code; we'd rather skip than corrupt).
 *
 * Why this is its own transform rather than chaining the prosemirror
 * helpers: `liftListItem` / `wrapInList` both rely on
 * `$from.blockRange($to, listItemPredicate)`, which returns null when
 * the selection's smallest common ancestor isn't a list — the case
 * you hit any time you select across two different lists, or a list
 * plus a non-list paragraph. So the bug "select a mix of bullets and
 * ordered, click Bullet, nothing happens" came from those helpers
 * silently bailing out. Doing it manually side-steps the predicate
 * entirely.
 */
export function applyListAction(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  target: ListKind,
  types: ListActionTypes
): boolean {
  const { from, to } = state.selection;
  const { blocks, hasCodeBlock } = inspectSelectionBlocks(state);
  if (hasCodeBlock || blocks.length === 0) return false;

  const allMatchTarget = blocks.every((k) => k === target);

  // Top-level doc children intersecting the selection. We only operate on
  // these — nested lists are left to their containing parents to handle.
  const topLevel: Array<{ pos: number; node: ProseNode }> = [];
  state.doc.forEach((child, offset) => {
    if (offset < to && offset + child.nodeSize > from) {
      topLevel.push({ pos: offset, node: child });
    }
  });
  if (topLevel.length === 0) return false;

  const tr = state.tr;

  // Reverse iteration so a replace at a later position doesn't invalidate
  // the earlier positions we still need to operate on.
  for (let i = topLevel.length - 1; i >= 0; i--) {
    const { pos, node } = topLevel[i];
    const isList =
      node.type === types.bulletList || node.type === types.orderedList;

    if (allMatchTarget && isList) {
      const replacement = buildToggleOffReplacement(node, pos, from, to);
      tr.replaceWith(pos, pos + node.nodeSize, replacement);
    } else if (!allMatchTarget && isList) {
      unifyExistingList(tr, pos, node, target, from, to, types);
    } else if (!allMatchTarget && node.isTextblock) {
      wrapBlockInNewList(tr, pos, node, target, types);
    }
    // (allMatchTarget && !isList) — plain block, toggle-off leaves alone
  }

  // Coalesce adjacent same-type lists. Without this, three paragraphs
  // wrapped as bullets via `wrapBlockInNewList` come out as three
  // separate `ul`s — each an "item 1" of its own — and unifying
  // ul+ol+ul to bullet leaves three adjacent bullet_lists instead of
  // one merged list.
  mergeAdjacentLists(tr, types);

  // Crepe's list_item carries its own `label` ("•" / "1." / …) and
  // `listType` ("bullet" / "ordered") attrs — its NodeView reads them
  // directly when rendering the marker. A `setNodeMarkup` that flips the
  // PARENT list's node type alone leaves every child list_item with
  // stale attrs, so the user keeps seeing numbered bullets after an
  // ordered→bullet conversion even though the doc structure says
  // bullet_list. Sync each list's items here against its current node
  // type, and renumber ordered lists from `attrs.order`. Runs after
  // the merge step so a list that just absorbed another list gets a
  // fresh sequential numbering across the combined item set.
  syncListItemAttrs(tr, types);

  if (tr.steps.length === 0) return false;
  if (dispatch) dispatch(tr);
  return true;
}

/**
 * Make every list_item's `label` and `listType` attrs match its parent
 * list's node type. For bullet/task lists every item gets `label: "•"` /
 * `listType: "bullet"`; for ordered lists items are renumbered starting
 * from the list's own `order` attr (default 1). `checked` is left
 * untouched here — task-vs-bullet semantics are decided per-item in
 * `unifyExistingList` based on selection, and the user's checked state
 * shouldn't be wiped by a sync pass.
 *
 * Two important reasons this exists separately from the type-flip in
 * `unifyExistingList`:
 *   - When two lists are merged by `mergeAdjacentLists`, the second
 *     list's items keep their original sequence numbers ("1.", "2." …).
 *     Renumbering must happen AFTER the merge so the combined list
 *     re-emits "1.", "2.", "3.", "4.".
 *   - A partial toggle-off of an ordered list (e.g. lift the middle
 *     item out) leaves the kept items with stale labels. The kept
 *     list_items still report their old "1.", "3." labels until we
 *     re-sync.
 */
function syncListItemAttrs(tr: Transaction, types: ListActionTypes): void {
  // Snapshot the list positions up front — every list_item change below
  // is a same-size setNodeMarkup so positions stay valid across calls.
  const lists: Array<{
    pos: number;
    node: ProseNode;
    isOrdered: boolean;
    startOrder: number;
  }> = [];
  tr.doc.forEach((child, offset) => {
    const isBullet = child.type === types.bulletList;
    const isOrdered = child.type === types.orderedList;
    if (!isBullet && !isOrdered) return;
    const order =
      isOrdered && typeof child.attrs.order === 'number'
        ? (child.attrs.order as number)
        : 1;
    lists.push({ pos: offset, node: child, isOrdered, startOrder: order });
  });

  for (const { pos, node, isOrdered, startOrder } of lists) {
    let liOffset = 1;
    let itemIndex = 0;
    node.forEach((li) => {
      const liStart = pos + liOffset;
      const desiredLabel = isOrdered ? `${startOrder + itemIndex}.` : '•';
      const desiredListType = isOrdered ? 'ordered' : 'bullet';
      const stale =
        li.attrs.label !== desiredLabel ||
        li.attrs.listType !== desiredListType;
      if (stale) {
        tr.setNodeMarkup(liStart, undefined, {
          ...li.attrs,
          label: desiredLabel,
          listType: desiredListType
        });
      }
      liOffset += li.nodeSize;
      itemIndex++;
    });
  }
}

/** Walk the current `tr.doc` and join any two adjacent same-type lists.
 *  Operates on top-level doc children — nested lists separated by a
 *  paragraph (the WYSIWYG analogue of a blank line between lists)
 *  stay separate, which is the right call for both markdown semantics
 *  and user intent. */
function mergeAdjacentLists(tr: Transaction, types: ListActionTypes): void {
  const joinAt: number[] = [];
  let lastListType: NodeType | null = null;
  let lastEnd = -1;
  tr.doc.forEach((child, offset) => {
    const isList =
      child.type === types.bulletList || child.type === types.orderedList;
    if (isList && lastListType === child.type && offset === lastEnd) {
      joinAt.push(offset);
    }
    lastListType = isList ? child.type : null;
    lastEnd = offset + child.nodeSize;
  });
  for (let i = joinAt.length - 1; i >= 0; i--) {
    tr.join(joinAt[i]);
  }
}

/** Replace a list with its inner content for items overlapping `[from, to]`.
 *  Items outside the selection stay as list_items, re-wrapped in lists of
 *  the original type so the doc structure remains valid (list_items can't
 *  exist outside a list). A partial unlist therefore splits the list. */
function buildToggleOffReplacement(
  listNode: ProseNode,
  listPos: number,
  from: number,
  to: number
): Fragment {
  const out: ProseNode[] = [];
  let keptItems: ProseNode[] = [];

  // +1 for the opening token of the list itself; each list_item's start
  // position is then listPos+1 plus the cumulative offset of preceding
  // list_items within this list.
  let liOffset = 1;
  listNode.forEach((li) => {
    const liStart = listPos + liOffset;
    const liEnd = liStart + li.nodeSize;
    const inSelection = liStart < to && liEnd > from;

    if (inSelection) {
      // Flush any accumulated kept items as their own list of the
      // original type, then emit the unwrapped paragraph content.
      if (keptItems.length > 0) {
        out.push(listNode.type.create(listNode.attrs, keptItems));
        keptItems = [];
      }
      li.forEach((child) => out.push(child));
    } else {
      keptItems.push(li);
    }
    liOffset += li.nodeSize;
  });

  if (keptItems.length > 0) {
    out.push(listNode.type.create(listNode.attrs, keptItems));
  }

  return Fragment.fromArray(out);
}

/** Change an existing list to match `target`. The list node's type flips
 *  (if different), and any list_item in selection gets its `checked` attr
 *  updated — `false` for task target, `null` for bullet/ordered. */
function unifyExistingList(
  tr: Transaction,
  pos: number,
  listNode: ProseNode,
  target: ListKind,
  from: number,
  to: number,
  types: ListActionTypes
): void {
  const targetListType =
    target === 'ordered' ? types.orderedList : types.bulletList;
  const targetChecked = target === 'task' ? false : null;

  if (listNode.type !== targetListType) {
    tr.setNodeMarkup(pos, targetListType, listNode.attrs);
  }

  let liOffset = 1;
  listNode.forEach((li) => {
    const liStart = pos + liOffset;
    const liEnd = liStart + li.nodeSize;
    if (liStart < to && liEnd > from) {
      const current = li.attrs.checked;
      const isTask = current !== null && current !== undefined;
      const wantsTask = targetChecked !== null;
      if (isTask !== wantsTask) {
        tr.setNodeMarkup(liStart, undefined, {
          ...li.attrs,
          checked: targetChecked
        });
      }
    }
    liOffset += li.nodeSize;
  });
}

/** Replace a single non-list textblock with a one-item list of `target`.
 *  Headings get re-emitted as paragraphs because CommonMark list_items
 *  with heading content render awkwardly and aren't what the user
 *  expects from clicking a list button.
 *
 *  Seeds `label` / `listType` to match the target list. `syncListItemAttrs`
 *  will renumber once adjacent lists have merged, so the "1." here is
 *  a placeholder — the right sequence number lands in the post-pass. */
function wrapBlockInNewList(
  tr: Transaction,
  pos: number,
  block: ProseNode,
  target: ListKind,
  types: ListActionTypes
): void {
  const inner =
    block.type === types.paragraph
      ? block
      : types.paragraph.create(null, block.content);

  const itemAttrs: Record<string, unknown> = {
    label: target === 'ordered' ? '1.' : '•',
    listType: target === 'ordered' ? 'ordered' : 'bullet',
    checked: target === 'task' ? false : null
  };
  const item = types.listItem.create(itemAttrs, inner);

  const listType = target === 'ordered' ? types.orderedList : types.bulletList;
  const newList = listType.create(null, item);

  tr.replaceWith(pos, pos + block.nodeSize, newList);
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
 * Milkdown wrapper: pulls the editor view and schema types out of `ctx`,
 * then defers to `applyListAction` for the actual transform. Kept thin
 * so the logic stays testable without a live Crepe instance.
 */
function switchListAction(target: ListKind) {
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
const insertMermaid = (ctx: Ctx) => {
  // Same recipe as `insertMath` but with `language: 'mermaid'`, which
  // the renderPreview hook in `$lib/editor/plugins/mermaid.ts` picks up
  // to render the diagram below the source. Always present in the
  // toolbar (matching the math convention) regardless of the
  // `editor.mermaid` setting — clicking it with the renderer off still
  // gives you a code block, just no preview.
  ctx.get(commandsCtx).call(addBlockTypeCommand.key, {
    nodeType: codeBlockSchema.type(ctx),
    attrs: { language: 'mermaid' }
  });
};

// -- Catalogue ---------------------------------------------------------------

export const TOOLBAR_ITEMS: ToolbarItem[] = [
  {
    kind: 'leaf',
    id: 'undo',
    labelKey: 'editor.toolbar.undo',
    icon: Undo2,
    action: undo,
    hotkeyId: 'editor.markdown.undo'
  },
  {
    kind: 'leaf',
    id: 'redo',
    labelKey: 'editor.toolbar.redo',
    icon: Redo2,
    action: redo,
    hotkeyId: 'editor.markdown.redo'
  },
  {
    kind: 'leaf',
    id: 'bold',
    labelKey: 'editor.toolbar.bold',
    icon: Bold,
    action: toggleBold,
    isActive: isBoldActive,
    hotkeyId: 'editor.markdown.bold'
  },
  {
    kind: 'leaf',
    id: 'italic',
    labelKey: 'editor.toolbar.italic',
    icon: Italic,
    action: toggleItalic,
    isActive: isItalicActive,
    hotkeyId: 'editor.markdown.italic'
  },
  {
    kind: 'group',
    id: 'text',
    labelKey: 'editor.toolbar.text.group',
    icon: Type,
    items: [
      {
        kind: 'leaf',
        id: 'p',
        labelKey: 'editor.toolbar.text.normal',
        icon: Pilcrow,
        action: turnIntoParagraph,
        hotkeyId: 'editor.markdown.paragraph'
      },
      {
        kind: 'leaf',
        id: 'h1',
        labelKey: 'editor.toolbar.text.h1',
        icon: Heading1,
        action: turnIntoHeading(1),
        hotkeyId: 'editor.markdown.h1'
      },
      {
        kind: 'leaf',
        id: 'h2',
        labelKey: 'editor.toolbar.text.h2',
        icon: Heading2,
        action: turnIntoHeading(2),
        hotkeyId: 'editor.markdown.h2'
      },
      {
        kind: 'leaf',
        id: 'h3',
        labelKey: 'editor.toolbar.text.h3',
        icon: Heading3,
        action: turnIntoHeading(3),
        hotkeyId: 'editor.markdown.h3'
      },
      {
        kind: 'leaf',
        id: 'h4',
        labelKey: 'editor.toolbar.text.h4',
        icon: Heading4,
        action: turnIntoHeading(4),
        hotkeyId: 'editor.markdown.h4'
      },
      {
        kind: 'leaf',
        id: 'h5',
        labelKey: 'editor.toolbar.text.h5',
        icon: Heading5,
        action: turnIntoHeading(5),
        hotkeyId: 'editor.markdown.h5'
      },
      {
        kind: 'leaf',
        id: 'h6',
        labelKey: 'editor.toolbar.text.h6',
        icon: Heading6,
        action: turnIntoHeading(6),
        hotkeyId: 'editor.markdown.h6'
      }
    ]
  },
  {
    kind: 'group',
    id: 'list',
    labelKey: 'editor.toolbar.list.group',
    icon: List,
    items: [
      {
        kind: 'leaf',
        id: 'ordered',
        labelKey: 'editor.toolbar.list.ordered',
        icon: ListOrdered,
        action: turnIntoOrderedList,
        hotkeyId: 'editor.markdown.orderedList'
      },
      {
        kind: 'leaf',
        id: 'bullet',
        labelKey: 'editor.toolbar.list.bullet',
        icon: List,
        action: turnIntoBulletList,
        hotkeyId: 'editor.markdown.bulletList'
      },
      {
        kind: 'leaf',
        id: 'task',
        labelKey: 'editor.toolbar.list.task',
        icon: ListTodo,
        action: turnIntoTaskList,
        hotkeyId: 'editor.markdown.taskList'
      }
    ]
  },
  {
    kind: 'group',
    id: 'advanced',
    labelKey: 'editor.toolbar.advanced.group',
    icon: Sparkles,
    items: [
      {
        kind: 'leaf',
        id: 'image',
        labelKey: 'editor.toolbar.advanced.image',
        icon: ImageIcon,
        action: insertImageBlock
      },
      {
        kind: 'leaf',
        id: 'code',
        labelKey: 'editor.toolbar.advanced.code',
        icon: Code,
        action: insertCodeBlock,
        hotkeyId: 'editor.markdown.codeBlock'
      },
      {
        kind: 'leaf',
        id: 'table',
        labelKey: 'editor.toolbar.advanced.table',
        icon: TableIcon,
        action: insertTable
      },
      {
        kind: 'leaf',
        id: 'math',
        labelKey: 'editor.toolbar.advanced.math',
        icon: Sigma,
        action: insertMath,
        gate: 'editor.math'
      },
      {
        kind: 'leaf',
        id: 'mermaid',
        labelKey: 'editor.toolbar.advanced.mermaid',
        icon: Workflow,
        action: insertMermaid,
        gate: 'editor.mermaid'
      }
    ]
  }
];
