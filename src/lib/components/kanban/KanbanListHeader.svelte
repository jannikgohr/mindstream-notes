<script lang="ts">
  import { onDestroy } from 'svelte';
  import { ChevronLeft, Ellipsis, GripVertical, Plus } from '@lucide/svelte';
  import type { KanbanColumnHeaderContext } from '@mindstream/svelte-kanban';
  import { tooltip } from '$lib/actions/tooltip';
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
    onOpenListManager?: () => void;
    mobile?: boolean;
  }

  let {
    context,
    renaming,
    onStartRename,
    onCommitRename,
    onCancelRename,
    onOpenMenu,
    onDragStart,
    onOpenListManager,
    mobile = false
  }: Props = $props();

  let renameInput = $state<HTMLInputElement | null>(null);
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdPointerId: number | null = null;
  let holdStartX = 0;
  let holdStartY = 0;
  let suppressTitleClick = false;
  let suppressResetTimer: ReturnType<typeof setTimeout> | null = null;
  const HOLD_DELAY_MS = 450;
  const HOLD_MOVE_TOLERANCE_PX = 8;

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

  function beginTitleHold(event: PointerEvent): void {
    if (!mobile || context.readonly || !onOpenListManager) return;
    clearTitleHold();
    holdPointerId = event.pointerId;
    holdStartX = event.clientX;
    holdStartY = event.clientY;
    holdTimer = setTimeout(() => {
      suppressTitleClick = true;
      if (suppressResetTimer) clearTimeout(suppressResetTimer);
      suppressResetTimer = setTimeout(() => {
        suppressTitleClick = false;
        suppressResetTimer = null;
      }, 800);
      clearTitleHold();
      onOpenListManager?.();
    }, HOLD_DELAY_MS);
    window.addEventListener('pointermove', moveTitleHold, true);
    window.addEventListener('pointerup', clearTitleHold, true);
    window.addEventListener('pointercancel', clearTitleHold, true);
  }

  function moveTitleHold(event: PointerEvent): void {
    if (event.pointerId !== holdPointerId) return;
    if (
      Math.hypot(event.clientX - holdStartX, event.clientY - holdStartY) >
      HOLD_MOVE_TOLERANCE_PX
    ) {
      clearTitleHold();
    }
  }

  function clearTitleHold(): void {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    holdPointerId = null;
    window.removeEventListener('pointermove', moveTitleHold, true);
    window.removeEventListener('pointerup', clearTitleHold, true);
    window.removeEventListener('pointercancel', clearTitleHold, true);
  }

  function handleTitleClick(): void {
    if (suppressTitleClick) {
      suppressTitleClick = false;
      if (suppressResetTimer) clearTimeout(suppressResetTimer);
      suppressResetTimer = null;
      return;
    }
    onStartRename();
  }

  onDestroy(() => {
    clearTitleHold();
    if (suppressResetTimer) clearTimeout(suppressResetTimer);
  });
</script>

<header class="wx-column-header mindstream-list-header" class:mobile>
  {#if !mobile}
    <button
      type="button"
      class="header-action drag-handle"
      aria-label={tUi('editor.kanban.reorderList')}
      use:tooltip={tUi('editor.kanban.reorderList')}
      disabled={context.readonly}
      onpointerdown={onDragStart}
    >
      <GripVertical aria-hidden="true" />
    </button>
  {/if}

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
      use:tooltip={context.column.label}
      disabled={context.readonly}
      onpointerdown={beginTitleHold}
      onclick={handleTitleClick}
      oncontextmenu={(event) => {
        if (mobile) event.preventDefault();
      }}
    >
      {context.column.label}
    </button>
  {/if}

  {#if mobile}
    <span class="card-count" aria-label={tUi('editor.kanban.cardCount')}>
      {context.column.cards.length}
    </span>
  {/if}

  <button
    type="button"
    class="header-action"
    aria-label={tUi('editor.kanban.addCard')}
    use:tooltip={tUi('editor.kanban.addCard')}
    disabled={context.readonly}
    onclick={context.addCard}
  >
    <Plus aria-hidden="true" />
  </button>

  <button
    type="button"
    class="header-action"
    aria-label={tUi('editor.kanban.listMenu')}
    use:tooltip={tUi('editor.kanban.listMenu')}
    disabled={context.readonly}
    onclick={onOpenMenu}
  >
    <Ellipsis aria-hidden="true" />
  </button>

  {#if !mobile}
    <button
      type="button"
      class="header-action"
      aria-label={tUi('editor.kanban.collapseList')}
      use:tooltip={tUi('editor.kanban.collapseList')}
      disabled={context.readonly}
      onclick={context.toggleCollapsed}
    >
      <ChevronLeft aria-hidden="true" />
    </button>
  {/if}
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

  .mindstream-list-header.mobile {
    min-height: 3.5rem;
    padding-inline: 0.75rem;
  }

  .mobile .header-action {
    width: 2.5rem;
    height: 2.5rem;
    flex-basis: 2.5rem;
  }

  .mobile .list-title {
    font-size: 1rem;
  }

  .card-count {
    color: var(--muted-foreground);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
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
</style>
