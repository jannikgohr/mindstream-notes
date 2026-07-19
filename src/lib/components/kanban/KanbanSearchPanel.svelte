<script lang="ts">
  import { Link, RotateCcw, Search, X } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { tUi } from '$lib/settings/i18n.svelte';
  import type { KanbanSearchFilters } from '$lib/kanban/kanban-search';
  import type {
    KanbanColumnData,
    KanbanLabelData
  } from '$lib/kanban/kanban-yjs';

  interface PriorityOption {
    id: number;
    label: string;
  }

  interface UserOption {
    id: string;
    label: string;
  }

  interface Props {
    filters: KanbanSearchFilters;
    columns: KanbanColumnData[];
    priorities: PriorityOption[];
    labels: KanbanLabelData[];
    users: UserOption[];
    matchCount: number;
    totalCount: number;
    onChange: (filters: KanbanSearchFilters) => void;
    onClose: () => void;
  }

  let {
    filters,
    columns,
    priorities,
    labels,
    users,
    matchCount,
    totalCount,
    onChange,
    onClose
  }: Props = $props();

  let inputEl = $state<HTMLInputElement | null>(null);

  export function focus() {
    inputEl?.focus();
    inputEl?.select();
  }

  const resultLabel = $derived(
    tUi('editor.kanban.searchResults')
      .replace('{count}', String(matchCount))
      .replace('{total}', String(totalCount))
  );

  function update(patch: Partial<KanbanSearchFilters>): void {
    onChange({ ...filters, ...patch });
  }

  function toggleString(key: 'columns' | 'labels' | 'users', id: string): void {
    const values = filters[key];
    update({
      [key]: values.includes(id)
        ? values.filter((item) => item !== id)
        : [...values, id]
    });
  }

  function togglePriority(id: number): void {
    update({
      priorities: filters.priorities.includes(id)
        ? filters.priorities.filter((item) => item !== id)
        : [...filters.priorities, id]
    });
  }

  function clear(): void {
    update({
      query: '',
      columns: [],
      priorities: [],
      labels: [],
      users: [],
      linkedOnly: false
    });
    inputEl?.focus();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onClose();
  }
</script>

<div class="kanban-search-panel" role="search">
  <div class="kanban-search-row">
    <div class="kanban-search-input-wrap">
      <Search aria-hidden="true" />
      <input
        bind:this={inputEl}
        type="text"
        value={filters.query}
        placeholder={tUi('editor.kanban.searchPlaceholder')}
        aria-label={tUi('editor.kanban.searchPlaceholder')}
        oninput={(event) => update({ query: event.currentTarget.value })}
        onkeydown={handleKeydown}
      />
    </div>
    <span
      class="kanban-search-count"
      class:kanban-search-count-empty={filters.query && matchCount === 0}
    >
      {resultLabel}
    </span>
    <Button
      variant="ghost"
      size="icon"
      class="size-7 text-muted-foreground"
      onclick={clear}
      title={tUi('editor.kanban.searchClear')}
      aria-label={tUi('editor.kanban.searchClear')}
    >
      <RotateCcw class="size-3.5" aria-hidden="true" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      class="size-7 text-muted-foreground"
      onclick={onClose}
      title={tUi('editor.kanban.searchClose')}
      aria-label={tUi('editor.kanban.searchClose')}
    >
      <X class="size-3.5" aria-hidden="true" />
    </Button>
  </div>

  <div class="kanban-filter-strip" aria-label={tUi('editor.kanban.filters')}>
    {#if columns.length > 0}
      <div class="kanban-filter-group">
        <span>{tUi('editor.kanban.searchList')}</span>
        {#each columns as column (column.id)}
          <button
            type="button"
            class:active={filters.columns.includes(column.id)}
            aria-pressed={filters.columns.includes(column.id)}
            onclick={() => toggleString('columns', column.id)}
          >
            {column.label}
          </button>
        {/each}
      </div>
    {/if}

    {#if priorities.length > 0}
      <div class="kanban-filter-group">
        <span>{tUi('editor.kanban.searchPriority')}</span>
        {#each priorities as priority (priority.id)}
          <button
            type="button"
            class:active={filters.priorities.includes(priority.id)}
            aria-pressed={filters.priorities.includes(priority.id)}
            onclick={() => togglePriority(priority.id)}
          >
            {priority.label}
          </button>
        {/each}
      </div>
    {/if}

    {#if labels.length > 0}
      <div class="kanban-filter-group">
        <span>{tUi('editor.kanban.searchLabels')}</span>
        {#each labels as label (label.id)}
          <button
            type="button"
            class="kanban-filter-label"
            class:active={filters.labels.includes(label.id)}
            aria-pressed={filters.labels.includes(label.id)}
            onclick={() => toggleString('labels', label.id)}
          >
            <span
              class="kanban-filter-swatch"
              style:background={label.color ?? 'var(--primary)'}
              aria-hidden="true"
            ></span>
            {label.label}
          </button>
        {/each}
      </div>
    {/if}

    {#if users.length > 0}
      <div class="kanban-filter-group">
        <span>{tUi('editor.kanban.searchAssignees')}</span>
        {#each users as user (user.id)}
          <button
            type="button"
            class:active={filters.users.includes(user.id)}
            aria-pressed={filters.users.includes(user.id)}
            onclick={() => toggleString('users', user.id)}
          >
            {user.label}
          </button>
        {/each}
      </div>
    {/if}

    <button
      type="button"
      class="kanban-linked-filter"
      class:active={filters.linkedOnly}
      aria-pressed={filters.linkedOnly}
      onclick={() => update({ linkedOnly: !filters.linkedOnly })}
    >
      <Link aria-hidden="true" />
      {tUi('editor.kanban.searchLinkedOnly')}
    </button>
  </div>
</div>

<style>
  .kanban-search-panel {
    display: flex;
    flex-shrink: 0;
    flex-direction: column;
    gap: 0.375rem;
    border-bottom: 1px solid var(--border);
    background: var(--background);
    padding: 0.375rem 0.5rem;
  }

  .kanban-search-row {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.375rem;
  }

  .kanban-search-input-wrap {
    display: flex;
    min-width: 12rem;
    flex: 1;
    align-items: center;
    gap: 0.375rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--card);
    padding: 0 0.5rem;
    color: var(--foreground);
  }

  .kanban-search-input-wrap:focus-within {
    border-color: var(--ring);
    box-shadow: 0 0 0 1px var(--ring);
  }

  .kanban-search-input-wrap :global(svg) {
    width: 0.875rem;
    height: 0.875rem;
    flex: 0 0 auto;
    color: var(--muted-foreground);
  }

  .kanban-search-input-wrap input {
    min-width: 0;
    width: 100%;
    height: 1.75rem;
    border: 0;
    outline: none;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.75rem;
  }

  .kanban-search-input-wrap input::placeholder {
    color: var(--muted-foreground);
  }

  .kanban-search-count {
    min-width: 4rem;
    color: var(--muted-foreground);
    font-size: 0.75rem;
    text-align: right;
    white-space: nowrap;
  }

  .kanban-search-count-empty {
    color: var(--destructive);
  }

  .kanban-filter-strip {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.5rem;
    overflow-x: auto;
    scrollbar-width: thin;
    scrollbar-color: oklch(from var(--foreground) l c h / 0.3) transparent;
  }

  .kanban-filter-strip::-webkit-scrollbar {
    width: 12px;
    height: 12px;
  }

  .kanban-filter-strip::-webkit-scrollbar-track {
    background: transparent;
  }

  .kanban-filter-strip::-webkit-scrollbar-thumb {
    background: oklch(from var(--foreground) l c h / 0.22);
    background-clip: content-box;
    border: 3px solid transparent;
    border-radius: 8px;
  }

  .kanban-filter-group {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 0.25rem;
  }

  .kanban-filter-group > span {
    color: var(--muted-foreground);
    font-size: 0.6875rem;
    font-weight: 600;
  }

  .kanban-filter-group button,
  .kanban-linked-filter {
    display: inline-flex;
    height: 1.625rem;
    align-items: center;
    gap: 0.25rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--card);
    color: var(--foreground);
    cursor: pointer;
    padding: 0 0.5rem;
    font-size: 0.6875rem;
    white-space: nowrap;
  }

  .kanban-filter-group button:hover,
  .kanban-linked-filter:hover {
    background: var(--accent);
    color: var(--accent-foreground);
  }

  .kanban-filter-group button.active,
  .kanban-linked-filter.active {
    border-color: color-mix(in srgb, var(--primary) 55%, var(--border));
    background: color-mix(in srgb, var(--primary) 16%, transparent);
    color: var(--foreground);
  }

  .kanban-filter-swatch {
    width: 0.5rem;
    height: 0.5rem;
    flex: 0 0 auto;
    border-radius: 999px;
  }

  .kanban-linked-filter {
    flex: 0 0 auto;
  }

  .kanban-linked-filter :global(svg) {
    width: 0.75rem;
    height: 0.75rem;
  }
</style>
