/**
 * Toolbar item catalogue + command recipes shared by the desktop and mobile
 * editor toolbars. Pure data — no Svelte, no DOM — so both UIs can render the
 * same set of commands without duplicating recipes.
 *
 * Recipes mirror Crepe's slash-menu (block-edit feature) so toolbar
 * invocations behave identically to the desktop "/" menu they replace on
 * mobile, and the desktop toolbar matches the slash menu it sits alongside.
 */

import { commandsCtx } from '@milkdown/kit/core';
import {
  clearTextInCurrentBlockCommand,
  setBlockTypeCommand,
  wrapInBlockTypeCommand,
  addBlockTypeCommand,
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

// -- Action helpers ----------------------------------------------------------

const undo = (ctx: Ctx) => {
  ctx.get(commandsCtx).call(undoCommand.key);
};
const redo = (ctx: Ctx) => {
  ctx.get(commandsCtx).call(redoCommand.key);
};
const turnIntoParagraph = (ctx: Ctx) => {
  const commands = ctx.get(commandsCtx);
  commands.call(clearTextInCurrentBlockCommand.key);
  commands.call(setBlockTypeCommand.key, {
    nodeType: paragraphSchema.type(ctx)
  });
};
const turnIntoHeading = (level: number) => (ctx: Ctx) => {
  const commands = ctx.get(commandsCtx);
  commands.call(clearTextInCurrentBlockCommand.key);
  commands.call(setBlockTypeCommand.key, {
    nodeType: headingSchema.type(ctx),
    attrs: { level }
  });
};
const turnIntoBulletList = (ctx: Ctx) => {
  const commands = ctx.get(commandsCtx);
  commands.call(clearTextInCurrentBlockCommand.key);
  commands.call(wrapInBlockTypeCommand.key, {
    nodeType: bulletListSchema.type(ctx)
  });
};
const turnIntoOrderedList = (ctx: Ctx) => {
  const commands = ctx.get(commandsCtx);
  commands.call(clearTextInCurrentBlockCommand.key);
  commands.call(wrapInBlockTypeCommand.key, {
    nodeType: orderedListSchema.type(ctx)
  });
};
const turnIntoTaskList = (ctx: Ctx) => {
  // No first-class wrapInTaskListCommand — task items live as list_item
  // nodes with a `checked` attribute (gfm task-list-item extends it).
  const commands = ctx.get(commandsCtx);
  commands.call(clearTextInCurrentBlockCommand.key);
  commands.call(wrapInBlockTypeCommand.key, {
    nodeType: listItemSchema.type(ctx),
    attrs: { checked: false }
  });
};
const insertImageBlock = (ctx: Ctx) => {
  const commands = ctx.get(commandsCtx);
  commands.call(clearTextInCurrentBlockCommand.key);
  commands.call(addBlockTypeCommand.key, {
    nodeType: imageBlockSchema.type(ctx)
  });
};
const turnIntoCodeBlock = (ctx: Ctx) => {
  const commands = ctx.get(commandsCtx);
  commands.call(clearTextInCurrentBlockCommand.key);
  commands.call(setBlockTypeCommand.key, {
    nodeType: codeBlockSchema.type(ctx)
  });
};
const insertTable = (ctx: Ctx) => {
  const commands = ctx.get(commandsCtx);
  commands.call(clearTextInCurrentBlockCommand.key);
  commands.call(addBlockTypeCommand.key, {
    nodeType: createTable(ctx, 3, 3)
  });
};
const insertMath = (ctx: Ctx) => {
  // Crepe's Latex feature renders math as a code block whose `language`
  // attribute is "LaTeX" — same recipe as the slash-menu math item.
  const commands = ctx.get(commandsCtx);
  commands.call(clearTextInCurrentBlockCommand.key);
  commands.call(addBlockTypeCommand.key, {
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
      { kind: 'leaf', id: 'code',  labelKey: 'editor.toolbar.advanced.code',  icon: Code,      action: turnIntoCodeBlock },
      { kind: 'leaf', id: 'table', labelKey: 'editor.toolbar.advanced.table', icon: TableIcon, action: insertTable },
      { kind: 'leaf', id: 'math',  labelKey: 'editor.toolbar.advanced.math',  icon: Sigma,     action: insertMath }
    ]
  }
];
