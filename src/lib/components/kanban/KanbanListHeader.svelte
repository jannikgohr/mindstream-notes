<script lang="ts">
  import {
    ChevronLeft,
    Ellipsis,
    GripVertical,
    Pencil,
    Plus
  } from '@lucide/svelte';
  import type { KanbanColumnHeaderContext } from '@mindstream/svelte-kanban';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    resolveInlineListEdit,
    type InlineListEditTrigger
  } from './inline-list-edit';

  interface Props {
    context: KanbanColumnHeaderContext;
    renaming: boolean;
    onStartRename: () => void;
    onCommitRename: (value: string) => void;
    onCancelRename: () => void;
    onOpenMenu: (event: MouseEvent) => void;
    onDragStart: (event: PointerEvent) => void;
  }

  let {
    context,
    renaming,
    onStartRename,
    onCommitRename,
    onCancelRename,
    onOpenMenu,
    onDragStart
  }: Props = $props();

  let renameInput = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (!renaming) return;
    queueMicrotask(() => {
      renameInput?.focus();
      renameInput?.select();
    });
  });

  function finishRename(value: string, trigger: InlineListEditTrigger): void {
    const result = resolveInlineListEdit(value, trigger);
    if (result.type === 'commit') onCommitRename(result.value);
    else onCancelRename();
  }

  function handleRenameKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    finishRename(
      (event.currentTarget as HTMLInputElement).value,
      event.key === 'Enter' ? 'enter' : 'escape'
    );
  }
</script>

<header class="wx-column-header mindstream-list-header">
  <button
    type="button"
    class="header-action drag-handle"
    aria-label={tUi('editor.kanban.reorderList')}
    title={tUi('editor.kanban.reorderList')}
    disabled={context.readonly}
    onpointerdown={onDragStart}
  >
    <GripVertical aria-hidden="true" />
  </button>

  {#if renaming}
    <input
      bind:this={renameInput}
      class="list-name-input"
      value={context.column.label}
      aria-label={tUi('editor.kanban.renameList')}
      onkeydown={handleRenameKeydown}
      onblur={(event) => finishRename(event.currentTarget.value, 'blur')}
    />
  {:else}
    <button
      type="button"
      class="list-title"
      title={context.column.label}
      disabled={context.readonly}
      onclick={onStartRename}
    >
      {context.column.label}
    </button>
  {/if}

  <span class="card-count">
    {context.column.cards.length}
  </span>

  <button
    type="button"
    class="header-action"
    aria-label={tUi('editor.kanban.addCard')}
    title={tUi('editor.kanban.addCard')}
    disabled={context.readonly}
    onclick={context.addCard}
  >
    <Plus aria-hidden="true" />
  </button>

  <button
    type="button"
    class="header-action rename-action"
    aria-label={tUi('editor.kanban.renameList')}
    title={tUi('editor.kanban.renameList')}
    disabled={context.readonly}
    onclick={onStartRename}
  >
    <Pencil aria-hidden="true" />
  </button>

  <button
    type="button"
    class="header-action"
    aria-label={tUi('editor.kanban.listMenu')}
    title={tUi('editor.kanban.listMenu')}
    disabled={context.readonly}
    onclick={onOpenMenu}
  >
    <Ellipsis aria-hidden="true" />
  </button>

  <button
    type="button"
    class="header-action"
    aria-label={tUi('editor.kanban.collapseList')}
    title={tUi('editor.kanban.collapseList')}
    disabled={context.readonly}
    onclick={context.toggleCollapsed}
  >
    <ChevronLeft aria-hidden="true" />
  </button>
</header>

<style>
  .mindstream-list-header {
    display: flex;
    min-height: 3rem;
    align-items: center;
    gap: 0.125rem;
    border-bottom: 1px solid var(--wx-kanban-border-color);
    padding: 0.5rem 0.375rem;
  }

  .header-action,
  .list-title {
    border: 0;
    background: transparent;
    color: var(--foreground);
  }

  .header-action {
    display: inline-flex;
    width: 1.75rem;
    height: 1.75rem;
    flex: 0 0 1.75rem;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    color: var(--muted-foreground);
    cursor: pointer;
  }

  .header-action:hover,
  .header-action:focus-visible,
  .list-title:hover,
  .list-title:focus-visible {
    background: var(--accent);
    color: var(--accent-foreground);
    outline: none;
  }

  .header-action:focus-visible,
  .list-title:focus-visible,
  .list-name-input:focus {
    box-shadow: 0 0 0 1px var(--ring);
  }

  .header-action:disabled,
  .list-title:disabled {
    cursor: default;
    opacity: 0.55;
  }

  .header-action :global(svg) {
    width: 1rem;
    height: 1rem;
  }

  .drag-handle {
    cursor: grab;
    touch-action: none;
  }

  .drag-handle:active {
    cursor: grabbing;
  }

  .list-title {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    border-radius: var(--radius-sm);
    padding: 0.25rem 0.375rem;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: text;
  }

  .list-name-input {
    min-width: 0;
    height: 1.75rem;
    flex: 1;
    border: 1px solid var(--ring);
    border-radius: var(--radius-sm);
    background: var(--background);
    padding: 0 0.375rem;
    color: var(--foreground);
    font-size: 0.875rem;
    font-weight: 600;
    outline: none;
  }

  .card-count {
    min-width: 1rem;
    color: var(--muted-foreground);
    text-align: center;
    font-size: 0.75rem;
  }

  .rename-action {
    opacity: 0;
  }

  .mindstream-list-header:hover .rename-action,
  .mindstream-list-header:focus-within .rename-action {
    opacity: 1;
  }
</style>
