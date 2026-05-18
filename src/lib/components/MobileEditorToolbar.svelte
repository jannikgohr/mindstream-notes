<script lang="ts">
  /**
   * Mobile-only formatting toolbar for the Crepe editor.
   *
   * Architecturally this is a *Svelte* "plugin", not a Milkdown ProseMirror
   * plugin. The Milkdown $prose/$command primitives are great for editor
   * behaviour, but a toolbar's value here is its UI — shadcn-svelte Buttons,
   * lucide-svelte icons, the project's tUi() translation pipeline. Wiring all
   * that through a vanilla-DOM Milkdown plugin would duplicate everything we
   * already have, so we keep the chrome in Svelte and only call *into* the
   * editor via `crepe.editor.action(ctx => commands.call(...))`.
   *
   * Command recipes mirror Crepe's own slash-menu (block-edit feature) so
   * users get identical behaviour to the desktop "/" menu they're missing on
   * mobile (we disable Crepe.Feature.BlockEdit on mobile — see NoteEditor).
   */

  import type { Crepe } from '@milkdown/crepe';
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
    Sigma,
    ChevronDown
  } from 'lucide-svelte';
  import type { ComponentType } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    crepe: Crepe | null;
  }
  let { crepe }: Props = $props();

  type GroupId = 'text' | 'list' | 'advanced';
  let activeGroup = $state<GroupId | null>(null);

  function runAction(action: (ctx: Ctx) => void, closeGroup = true) {
    if (!crepe) return;
    crepe.editor.action(action);
    if (closeGroup) activeGroup = null;
  }

  function toggleGroup(id: GroupId) {
    activeGroup = activeGroup === id ? null : id;
  }

  /**
   * Toolbar buttons must NOT steal focus from the editor — otherwise on
   * mobile the soft keyboard collapses between every tap and the user loses
   * their caret. Calling preventDefault on pointerdown short-circuits the
   * browser's default "give focus to the tapped button" behaviour while
   * still letting the click handler fire.
   */
  function holdFocus(e: Event) {
    e.preventDefault();
  }

  // -- Command recipes (mirrored from Crepe's block-edit feature) ----------

  function undo() {
    runAction((ctx) => ctx.get(commandsCtx).call(undoCommand.key), false);
  }
  function redo() {
    runAction((ctx) => ctx.get(commandsCtx).call(redoCommand.key), false);
  }
  function turnIntoParagraph() {
    runAction((ctx) => {
      const commands = ctx.get(commandsCtx);
      commands.call(clearTextInCurrentBlockCommand.key);
      commands.call(setBlockTypeCommand.key, {
        nodeType: paragraphSchema.type(ctx)
      });
    });
  }
  function turnIntoHeading(level: number) {
    runAction((ctx) => {
      const commands = ctx.get(commandsCtx);
      commands.call(clearTextInCurrentBlockCommand.key);
      commands.call(setBlockTypeCommand.key, {
        nodeType: headingSchema.type(ctx),
        attrs: { level }
      });
    });
  }
  function turnIntoBulletList() {
    runAction((ctx) => {
      const commands = ctx.get(commandsCtx);
      commands.call(clearTextInCurrentBlockCommand.key);
      commands.call(wrapInBlockTypeCommand.key, {
        nodeType: bulletListSchema.type(ctx)
      });
    });
  }
  function turnIntoOrderedList() {
    runAction((ctx) => {
      const commands = ctx.get(commandsCtx);
      commands.call(clearTextInCurrentBlockCommand.key);
      commands.call(wrapInBlockTypeCommand.key, {
        nodeType: orderedListSchema.type(ctx)
      });
    });
  }
  function turnIntoTaskList() {
    // No first-class wrapInTaskListCommand — task items live as list_item
    // nodes with a `checked` attribute (gfm task-list-item extends it).
    runAction((ctx) => {
      const commands = ctx.get(commandsCtx);
      commands.call(clearTextInCurrentBlockCommand.key);
      commands.call(wrapInBlockTypeCommand.key, {
        nodeType: listItemSchema.type(ctx),
        attrs: { checked: false }
      });
    });
  }
  function insertImageBlock() {
    runAction((ctx) => {
      const commands = ctx.get(commandsCtx);
      commands.call(clearTextInCurrentBlockCommand.key);
      commands.call(addBlockTypeCommand.key, {
        nodeType: imageBlockSchema.type(ctx)
      });
    });
  }
  function turnIntoCodeBlock() {
    runAction((ctx) => {
      const commands = ctx.get(commandsCtx);
      commands.call(clearTextInCurrentBlockCommand.key);
      commands.call(setBlockTypeCommand.key, {
        nodeType: codeBlockSchema.type(ctx)
      });
    });
  }
  function insertTable() {
    runAction((ctx) => {
      const commands = ctx.get(commandsCtx);
      commands.call(clearTextInCurrentBlockCommand.key);
      commands.call(addBlockTypeCommand.key, {
        nodeType: createTable(ctx, 3, 3)
      });
    });
  }
  function insertMath() {
    // Crepe's Latex feature renders math as a code block whose `language`
    // attribute is "LaTeX" — same recipe as the slash-menu math item.
    runAction((ctx) => {
      const commands = ctx.get(commandsCtx);
      commands.call(clearTextInCurrentBlockCommand.key);
      commands.call(addBlockTypeCommand.key, {
        nodeType: codeBlockSchema.type(ctx),
        attrs: { language: 'LaTeX' }
      });
    });
  }

  // lucide-svelte still ships legacy `SvelteComponentTyped` class components,
  // not Svelte 5 functional `Component`s — `ComponentType` accepts both.
  interface SubItem {
    id: string;
    labelKey: string;
    icon: ComponentType;
    onClick: () => void;
  }

  const textItems: SubItem[] = [
    { id: 'p',  labelKey: 'editor.toolbar.text.normal', icon: Pilcrow,  onClick: turnIntoParagraph },
    { id: 'h1', labelKey: 'editor.toolbar.text.h1',     icon: Heading1, onClick: () => turnIntoHeading(1) },
    { id: 'h2', labelKey: 'editor.toolbar.text.h2',     icon: Heading2, onClick: () => turnIntoHeading(2) },
    { id: 'h3', labelKey: 'editor.toolbar.text.h3',     icon: Heading3, onClick: () => turnIntoHeading(3) },
    { id: 'h4', labelKey: 'editor.toolbar.text.h4',     icon: Heading4, onClick: () => turnIntoHeading(4) },
    { id: 'h5', labelKey: 'editor.toolbar.text.h5',     icon: Heading5, onClick: () => turnIntoHeading(5) },
    { id: 'h6', labelKey: 'editor.toolbar.text.h6',     icon: Heading6, onClick: () => turnIntoHeading(6) }
  ];

  const listItems: SubItem[] = [
    { id: 'bullet',  labelKey: 'editor.toolbar.list.bullet',  icon: List,        onClick: turnIntoBulletList },
    { id: 'ordered', labelKey: 'editor.toolbar.list.ordered', icon: ListOrdered, onClick: turnIntoOrderedList },
    { id: 'task',    labelKey: 'editor.toolbar.list.task',    icon: ListTodo,    onClick: turnIntoTaskList }
  ];

  const advancedItems: SubItem[] = [
    { id: 'image', labelKey: 'editor.toolbar.advanced.image', icon: ImageIcon, onClick: insertImageBlock },
    { id: 'code',  labelKey: 'editor.toolbar.advanced.code',  icon: Code,      onClick: turnIntoCodeBlock },
    { id: 'table', labelKey: 'editor.toolbar.advanced.table', icon: TableIcon, onClick: insertTable },
    { id: 'math',  labelKey: 'editor.toolbar.advanced.math',  icon: Sigma,     onClick: insertMath }
  ];

  const subItemsByGroup: Record<GroupId, SubItem[]> = {
    text: textItems,
    list: listItems,
    advanced: advancedItems
  };
</script>

<div
  class="flex shrink-0 flex-col border-b border-border bg-background"
  role="toolbar"
  aria-label={tUi('editor.toolbar.label')}
>
  <div class="flex items-center gap-0.5 px-1 py-1">
    <Button
      variant="ghost"
      size="icon"
      class="size-9"
      disabled={!crepe}
      onpointerdown={holdFocus}
      onclick={undo}
      title={tUi('editor.toolbar.undo')}
      aria-label={tUi('editor.toolbar.undo')}
    >
      <Undo2 class="size-4" aria-hidden="true" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      class="size-9"
      disabled={!crepe}
      onpointerdown={holdFocus}
      onclick={redo}
      title={tUi('editor.toolbar.redo')}
      aria-label={tUi('editor.toolbar.redo')}
    >
      <Redo2 class="size-4" aria-hidden="true" />
    </Button>

    <div class="mx-1 h-5 w-px bg-border" aria-hidden="true"></div>

    <Button
      variant={activeGroup === 'text' ? 'secondary' : 'ghost'}
      size="sm"
      class="h-9 gap-1 px-2"
      disabled={!crepe}
      onpointerdown={holdFocus}
      onclick={() => toggleGroup('text')}
      aria-expanded={activeGroup === 'text'}
      aria-label={tUi('editor.toolbar.text.group')}
    >
      <Type class="size-4" aria-hidden="true" />
      <span class="text-xs">{tUi('editor.toolbar.text.group')}</span>
      <ChevronDown
        class="size-3 transition-transform {activeGroup === 'text' ? 'rotate-180' : ''}"
        aria-hidden="true"
      />
    </Button>
    <Button
      variant={activeGroup === 'list' ? 'secondary' : 'ghost'}
      size="sm"
      class="h-9 gap-1 px-2"
      disabled={!crepe}
      onpointerdown={holdFocus}
      onclick={() => toggleGroup('list')}
      aria-expanded={activeGroup === 'list'}
      aria-label={tUi('editor.toolbar.list.group')}
    >
      <List class="size-4" aria-hidden="true" />
      <span class="text-xs">{tUi('editor.toolbar.list.group')}</span>
      <ChevronDown
        class="size-3 transition-transform {activeGroup === 'list' ? 'rotate-180' : ''}"
        aria-hidden="true"
      />
    </Button>
    <Button
      variant={activeGroup === 'advanced' ? 'secondary' : 'ghost'}
      size="sm"
      class="h-9 gap-1 px-2"
      disabled={!crepe}
      onpointerdown={holdFocus}
      onclick={() => toggleGroup('advanced')}
      aria-expanded={activeGroup === 'advanced'}
      aria-label={tUi('editor.toolbar.advanced.group')}
    >
      <Sparkles class="size-4" aria-hidden="true" />
      <span class="text-xs">{tUi('editor.toolbar.advanced.group')}</span>
      <ChevronDown
        class="size-3 transition-transform {activeGroup === 'advanced' ? 'rotate-180' : ''}"
        aria-hidden="true"
      />
    </Button>
  </div>

  {#if activeGroup}
    <div
      class="themed-scrollbar flex items-center gap-0.5 overflow-x-auto border-t border-border px-1 py-1"
      role="group"
      aria-label={tUi(`editor.toolbar.${activeGroup}.group`)}
    >
      {#each subItemsByGroup[activeGroup] as item (item.id)}
        {@const Icon = item.icon}
        <Button
          variant="ghost"
          size="sm"
          class="h-9 shrink-0 gap-1 px-2"
          disabled={!crepe}
          onpointerdown={holdFocus}
          onclick={item.onClick}
          title={tUi(item.labelKey)}
          aria-label={tUi(item.labelKey)}
        >
          <Icon class="size-4" aria-hidden="true" />
          <span class="text-xs">{tUi(item.labelKey)}</span>
        </Button>
      {/each}
    </div>
  {/if}
</div>
