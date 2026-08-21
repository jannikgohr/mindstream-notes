<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { GripVertical, Pencil, X } from '@lucide/svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { moveItemToIndex } from '$lib/actions/horizontal-reorder';
  import {
    resolveInlineListEdit,
    type InlineListEditTrigger
  } from './inline-list-edit';

  interface ListItem {
    id: string;
    label: string;
  }

  interface Props {
    columns: ListItem[];
    activeId: string | null;
    onReorder: (ids: string[]) => void;
    onRename: (id: string, value: string) => void;
    onClose: () => void;
  }

  interface DragVisual {
    left: number;
    top: number;
    width: number;
    grabY: number;
  }

  let { columns, activeId, onReorder, onRename, onClose }: Props = $props();

  const initialColumns = untrack(() =>
    columns.map((column) => ({ ...column }))
  );
  let ordered = $state<ListItem[]>(initialColumns);
  let listContainer = $state<HTMLDivElement | null>(null);
  let editingId = $state<string | null>(null);
  let editInput = $state<HTMLInputElement | null>(null);
  let draggedId = $state<string | null>(null);
  let dragVisual = $state<DragVisual | null>(null);
  let dragPointerId: number | null = null;
  let persistedOrder = initialColumns.map((column) => column.id).join('\u0000');
  const draggedColumn = $derived(
    ordered.find((column) => column.id === draggedId) ?? null
  );

  $effect(() => {
    if (!editingId) return;
    queueMicrotask(() => {
      editInput?.focus();
      editInput?.select();
    });
  });

  function startRename(id: string): void {
    editingId = id;
  }

  function finishRename(
    id: string,
    value: string,
    trigger: InlineListEditTrigger
  ): void {
    if (editingId !== id) return;
    const result = resolveInlineListEdit(value, trigger);
    editingId = null;
    if (result.type !== 'commit') return;
    ordered = ordered.map((column) =>
      column.id === id ? { ...column, label: result.value } : column
    );
    onRename(id, result.value);
  }

  function handleRenameKeydown(event: KeyboardEvent, id: string): void {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    finishRename(
      id,
      event.currentTarget instanceof HTMLInputElement
        ? event.currentTarget.value
        : '',
      event.key === 'Enter' ? 'enter' : 'escape'
    );
  }

  function beginDrag(event: PointerEvent, id: string): void {
    if (event.button !== 0 || editingId) return;
    const row = (event.currentTarget as HTMLElement).closest<HTMLElement>(
      '[data-manage-list-id]'
    );
    if (!row) return;
    const rect = row.getBoundingClientRect();
    event.preventDefault();
    draggedId = id;
    dragPointerId = event.pointerId;
    dragVisual = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      grabY: event.clientY - rect.top
    };
    window.addEventListener('pointermove', moveDrag, { capture: true });
    window.addEventListener('pointerup', finishDrag, { capture: true });
    window.addEventListener('pointercancel', cancelDrag, { capture: true });
  }

  function moveDrag(event: PointerEvent): void {
    if (
      !draggedId ||
      event.pointerId !== dragPointerId ||
      !listContainer ||
      !dragVisual
    )
      return;
    event.preventDefault();
    dragVisual.top = event.clientY - dragVisual.grabY;

    const containerRect = listContainer.getBoundingClientRect();
    if (event.clientY < containerRect.top + 48) listContainer.scrollTop -= 12;
    else if (event.clientY > containerRect.bottom - 48)
      listContainer.scrollTop += 12;

    const otherRows = Array.from(
      listContainer.querySelectorAll<HTMLElement>('[data-manage-list-id]')
    ).filter((row) => row.dataset.manageListId !== draggedId);
    const insertIndex = otherRows.filter((row) => {
      const rect = row.getBoundingClientRect();
      return event.clientY > rect.top + rect.height / 2;
    }).length;
    ordered = moveItemToIndex(ordered, draggedId, insertIndex);
  }

  function finishDrag(event: PointerEvent): void {
    if (!draggedId || event.pointerId !== dragPointerId) return;
    cleanupDrag();
    const nextOrder = ordered.map((column) => column.id);
    const nextKey = nextOrder.join('\u0000');
    if (nextKey === persistedOrder) return;
    persistedOrder = nextKey;
    onReorder(nextOrder);
  }

  function cancelDrag(event: PointerEvent): void {
    if (!draggedId || event.pointerId !== dragPointerId) return;
    ordered = columns.map((column) => ({ ...column }));
    cleanupDrag();
  }

  function cleanupDrag(): void {
    window.removeEventListener('pointermove', moveDrag, true);
    window.removeEventListener('pointerup', finishDrag, true);
    window.removeEventListener('pointercancel', cancelDrag, true);
    draggedId = null;
    dragVisual = null;
    dragPointerId = null;
  }

  onDestroy(cleanupDrag);
</script>

<button
  type="button"
  class="backdrop"
  aria-label={tUi('close')}
  onclick={onClose}
></button>
<div
  class="sheet"
  role="dialog"
  aria-modal="true"
  aria-labelledby="mobile-list-manager-title"
>
  <div class="sheet-handle" aria-hidden="true"></div>
  <header>
    <div>
      <h2 id="mobile-list-manager-title">
        {tUi('editor.kanban.manageLists')}
      </h2>
      <p>{tUi('editor.kanban.manageListsHint')}</p>
    </div>
    <button
      type="button"
      class="close-button"
      aria-label={tUi('close')}
      onclick={onClose}
    >
      <X aria-hidden="true" />
    </button>
  </header>

  <div class="list" bind:this={listContainer}>
    {#each ordered as column (column.id)}
      {#if column.id === draggedId}
        <div
          class="list-placeholder"
          data-manage-list-id={column.id}
          aria-hidden="true"
        ></div>
      {:else}
        <div
          class="list-row"
          class:active={column.id === activeId}
          data-manage-list-id={column.id}
        >
          <button
            type="button"
            class="drag-handle"
            aria-label={tUi('editor.kanban.reorderList')}
            onpointerdown={(event) => beginDrag(event, column.id)}
          >
            <GripVertical aria-hidden="true" />
          </button>

          {#if editingId === column.id}
            <input
              bind:this={editInput}
              value={column.label}
              aria-label={tUi('editor.kanban.renameList')}
              onkeydown={(event) => handleRenameKeydown(event, column.id)}
              onblur={(event) =>
                finishRename(column.id, event.currentTarget.value, 'blur')}
            />
          {:else}
            <span class="list-label">{column.label}</span>
          {/if}

          <button
            type="button"
            class="rename-button"
            aria-label={tUi('editor.kanban.renameList')}
            onclick={() => startRename(column.id)}
          >
            <Pencil aria-hidden="true" />
          </button>
        </div>
      {/if}
    {/each}
  </div>

  {#if draggedColumn && dragVisual}
    <div
      class="list-row drag-ghost"
      aria-hidden="true"
      style:left={`${dragVisual.left}px`}
      style:top={`${dragVisual.top}px`}
      style:width={`${dragVisual.width}px`}
    >
      <span class="drag-handle"><GripVertical aria-hidden="true" /></span>
      <span class="list-label">{draggedColumn.label}</span>
      <span class="rename-button"><Pencil aria-hidden="true" /></span>
    </div>
  {/if}
</div>

<style>
  .backdrop {
    position: fixed;
    z-index: 280;
    inset: 0;
    border: 0;
    background: var(--scrim);
  }

  .sheet {
    position: fixed;
    z-index: 281;
    right: 0;
    bottom: 0;
    left: 0;
    max-height: min(78dvh, 42rem);
    overflow: hidden;
    border: 1px solid var(--border);
    border-bottom: 0;
    border-radius: 1rem 1rem 0 0;
    background: var(--background);
    box-shadow: 0 -16px 40px rgb(0 0 0 / 0.28);
    color: var(--foreground);
    padding: 0 1rem calc(1rem + env(safe-area-inset-bottom));
  }

  .sheet-handle {
    width: 2.25rem;
    height: 0.25rem;
    margin: 0.5rem auto 0;
    border-radius: 999px;
    background: var(--muted-foreground);
    opacity: 0.45;
  }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 0;
  }

  h2 {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 650;
  }

  p {
    margin: 0.2rem 0 0;
    color: var(--muted-foreground);
    font-size: 0.8125rem;
  }

  button {
    border: 0;
    background: transparent;
    color: inherit;
  }

  .close-button,
  .drag-handle,
  .rename-button {
    display: inline-flex;
    width: 2.75rem;
    height: 2.75rem;
    flex: 0 0 2.75rem;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    color: var(--muted-foreground);
  }

  .close-button:focus-visible,
  .drag-handle:focus-visible,
  .rename-button:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: -2px;
  }

  .close-button :global(svg),
  .drag-handle :global(svg),
  .rename-button :global(svg) {
    width: 1.125rem;
    height: 1.125rem;
  }

  .list {
    max-height: calc(min(78dvh, 42rem) - 6.5rem);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-bottom: 0.25rem;
  }

  .list-row {
    display: flex;
    min-height: 3.5rem;
    align-items: center;
    gap: 0.25rem;
    margin-bottom: 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--card);
    transition:
      border-color 120ms ease,
      box-shadow 120ms ease,
      opacity 120ms ease;
  }

  .list-row.active,
  .list-row:focus-within {
    border-color: var(--ring);
  }

  .list-placeholder {
    box-sizing: border-box;
    height: 3.5rem;
    margin-bottom: 0.5rem;
    border: 1px dashed var(--ring);
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--ring) 10%, transparent);
  }

  .drag-ghost {
    position: fixed;
    z-index: 282;
    margin: 0;
    border-color: var(--ring);
    opacity: 0.96;
    box-shadow:
      0 0 0 1px var(--ring),
      0 8px 20px rgb(0 0 0 / 0.22);
    pointer-events: none;
    will-change: top;
  }

  .drag-handle {
    cursor: grab;
    touch-action: none;
  }

  .drag-handle:active {
    cursor: grabbing;
  }

  .list-label,
  input {
    min-width: 0;
    flex: 1;
    font-size: 0.9375rem;
    font-weight: 600;
  }

  .list-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  input {
    height: 2.25rem;
    border: 0;
    border-bottom: 2px solid var(--ring);
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    background: color-mix(in srgb, var(--ring) 8%, transparent);
    padding: 0 0.375rem;
    color: var(--foreground);
    outline: none;
  }
</style>
