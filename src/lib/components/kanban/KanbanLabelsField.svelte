<script lang="ts">
  import { Plus, X } from '@lucide/svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  export interface KanbanLabelOption {
    id: string;
    label: string;
    color?: string;
    unused?: boolean;
  }

  interface Props {
    value?: string[];
    options?: KanbanLabelOption[];
    disabled?: boolean;
    error?: boolean;
    placeholder?: string;
    oncreate?: (label: string) => KanbanLabelOption | null | undefined;
    ondelete?: (id: string) => void;
    onchange?: (ev: { value: string[]; input?: boolean }) => void;
  }

  let {
    value = [],
    options = [],
    disabled = false,
    error = false,
    placeholder = tUi('editor.kanban.labelsPlaceholder'),
    oncreate,
    ondelete,
    onchange
  }: Props = $props();

  const MAX_RESULTS = 8;

  let root = $state<HTMLDivElement | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);
  let open = $state(false);
  let query = $state('');
  let highlight = $state(0);

  const selected = $derived(
    value
      .map((id) => options.find((option) => option.id === id))
      .filter((option): option is KanbanLabelOption => Boolean(option))
  );

  const missingSelected = $derived(
    value
      .filter((id) => !options.some((option) => option.id === id))
      .map((id): KanbanLabelOption => ({ id, label: id }))
  );

  const selectedIds = $derived(new Set(value));
  const normalizedQuery = $derived(query.trim().toLowerCase());
  const canCreate = $derived(
    Boolean(query.trim()) &&
      !options.some(
        (option) => option.label.trim().toLowerCase() === normalizedQuery
      )
  );

  const results = $derived.by(() => {
    const q = normalizedQuery;
    return options
      .filter((option) => !selectedIds.has(option.id))
      .map((option) => {
        const label = option.label.toLowerCase();
        const idx = q ? label.indexOf(q) : 0;
        if (idx < 0) return null;
        return {
          option,
          rank: idx === 0 ? 0 : idx + label.length / 1000
        };
      })
      .filter((entry): entry is { option: KanbanLabelOption; rank: number } =>
        Boolean(entry)
      )
      .sort((a, b) => a.rank - b.rank)
      .slice(0, MAX_RESULTS)
      .map((entry) => entry.option);
  });

  $effect(() => {
    if (highlight >= results.length)
      highlight = Math.max(0, results.length - 1);
  });

  $effect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (root?.contains(event.target as Node)) return;
      open = false;
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  });

  function emit(next: string[]): void {
    onchange?.({ value: next, input: true });
  }

  function add(option: KanbanLabelOption): void {
    if (selectedIds.has(option.id)) return;
    emit([...value, option.id]);
    query = '';
    open = true;
    highlight = 0;
    inputEl?.focus();
  }

  function createFromQuery(): void {
    const label = query.trim();
    if (!label || !oncreate) return;
    const created = oncreate(label);
    if (!created) return;
    add(created);
  }

  function remove(id: string, event?: MouseEvent): void {
    event?.preventDefault();
    event?.stopPropagation();
    emit(value.filter((item) => item !== id));
  }

  function deleteUnused(option: KanbanLabelOption, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (!option.unused) return;
    ondelete?.(option.id);
    highlight = 0;
    inputEl?.focus();
  }

  function handleResultKeydown(
    option: KanbanLabelOption,
    event: KeyboardEvent
  ): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    add(option);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (disabled) return;
    if (event.key === 'ArrowDown') {
      open = true;
      highlight = Math.min(highlight + 1, Math.max(0, results.length - 1));
      event.preventDefault();
    } else if (event.key === 'ArrowUp') {
      open = true;
      highlight = Math.max(0, highlight - 1);
      event.preventDefault();
    } else if (event.key === 'Enter') {
      const picked = open ? results[highlight] : undefined;
      if (picked) add(picked);
      else if (canCreate) createFromQuery();
      event.preventDefault();
    } else if (event.key === 'Backspace' && !query && value.length > 0) {
      remove(value[value.length - 1]);
      event.preventDefault();
    } else if (event.key === 'Escape') {
      open = false;
      event.preventDefault();
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
  class="kanban-label-field"
  class:kanban-label-field-error={error}
  class:kanban-label-field-disabled={disabled}
  bind:this={root}
  role="presentation"
  onclick={() => inputEl?.focus()}
>
  <div class="kanban-label-shell">
    {#each [...selected, ...missingSelected] as label (label.id)}
      <span class="kanban-label-chip">
        <span
          class="kanban-label-swatch"
          style:background={label.color ?? 'var(--wx-color-primary)'}
          aria-hidden="true"
        ></span>
        <span class="kanban-label-chip-text">{label.label}</span>
        {#if !disabled}
          <button
            type="button"
            aria-label={tUi('editor.kanban.removeLabel').replace(
              '{label}',
              label.label
            )}
            title={tUi('editor.kanban.removeLabel').replace(
              '{label}',
              label.label
            )}
            onclick={(event) => remove(label.id, event)}
          >
            <X aria-hidden="true" />
          </button>
        {/if}
      </span>
    {/each}
    <input
      bind:this={inputEl}
      type="text"
      bind:value={query}
      {placeholder}
      {disabled}
      onfocus={() => (open = true)}
      oninput={() => {
        open = true;
        highlight = 0;
      }}
      onkeydown={handleKeydown}
    />
  </div>

  {#if open && !disabled}
    <div class="kanban-label-results" role="listbox">
      {#if results.length > 0}
        {#each results as option, index (option.id)}
          <div
            class="kanban-label-result"
            class:kanban-label-result-active={index === highlight}
            role="option"
            tabindex="0"
            aria-selected={index === highlight}
            onmouseenter={() => (highlight = index)}
            onkeydown={(event) => handleResultKeydown(option, event)}
            onclick={() => add(option)}
          >
            <span
              class="kanban-label-swatch"
              style:background={option.color ?? 'var(--wx-color-primary)'}
              aria-hidden="true"
            ></span>
            <span class="kanban-label-result-text">{option.label}</span>
            {#if option.unused}
              <button
                type="button"
                class="kanban-label-delete"
                aria-label={tUi('editor.kanban.deleteUnusedLabel').replace(
                  '{label}',
                  option.label
                )}
                title={tUi('editor.kanban.deleteUnusedLabel').replace(
                  '{label}',
                  option.label
                )}
                onclick={(event) => deleteUnused(option, event)}
              >
                <X aria-hidden="true" />
              </button>
            {/if}
          </div>
        {/each}
      {/if}
      {#if canCreate}
        <button
          type="button"
          class="kanban-label-result kanban-label-create"
          onclick={createFromQuery}
        >
          <Plus aria-hidden="true" />
          <span>
            {tUi('editor.kanban.createLabel').replace('{label}', query.trim())}
          </span>
        </button>
      {:else if results.length === 0}
        <div class="kanban-label-empty">{tUi('editor.kanban.noLabels')}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .kanban-label-field {
    position: relative;
    width: 100%;
  }

  .kanban-label-shell {
    display: flex;
    min-height: var(--wx-input-height);
    flex-wrap: wrap;
    align-items: center;
    gap: 5px;
    border: var(--wx-input-border);
    border-radius: var(--wx-input-border-radius);
    background: var(--wx-input-background);
    color: var(--wx-input-font-color);
    padding: 5px 6px;
    cursor: text;
  }

  .kanban-label-field:focus-within .kanban-label-shell {
    border: var(--wx-input-border-focus);
  }

  .kanban-label-field-error .kanban-label-shell {
    border-color: var(--wx-color-danger);
  }

  .kanban-label-field-disabled {
    opacity: 0.7;
  }

  .kanban-label-chip,
  .kanban-label-result {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: 6px;
  }

  .kanban-label-chip {
    max-width: 100%;
    border-radius: 999px;
    background: var(--wx-background-hover);
    color: var(--wx-color-font);
    padding: 3px 5px 3px 7px;
    font-size: var(--wx-font-size-sm);
    line-height: 1.3;
  }

  .kanban-label-chip-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kanban-label-swatch {
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border-radius: 999px;
  }

  .kanban-label-chip button {
    display: inline-flex;
    width: 16px;
    height: 16px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--wx-color-font-alt);
    cursor: pointer;
    padding: 0;
  }

  .kanban-label-chip button:hover {
    background: color-mix(in srgb, var(--wx-color-font) 12%, transparent);
    color: var(--wx-color-font);
  }

  .kanban-label-chip button :global(svg) {
    width: 12px;
    height: 12px;
  }

  input {
    min-width: 120px;
    flex: 1;
    border: 0;
    outline: none;
    background: transparent;
    color: inherit;
    font: inherit;
    line-height: var(--wx-input-line-height);
    padding: 3px 0;
  }

  :global(.kanban-card-editor .kanban-label-field input),
  :global(.kanban-card-editor .kanban-label-field input:focus) {
    border: 0;
    box-shadow: none;
  }

  input::placeholder {
    color: var(--wx-input-placeholder-color);
  }

  .kanban-label-results {
    position: absolute;
    z-index: 30;
    top: calc(100% + 4px);
    right: 0;
    left: 0;
    max-height: 260px;
    overflow-y: auto;
    border: 1px solid var(--wx-border-color);
    border-radius: 6px;
    background: var(--wx-background);
    box-shadow: var(--wx-popup-shadow, 0 12px 30px rgb(0 0 0 / 0.18));
    padding: 4px;
  }

  .kanban-label-result {
    width: 100%;
    justify-content: flex-start;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--wx-color-font);
    cursor: pointer;
    padding: 6px 8px;
    text-align: left;
  }

  .kanban-label-result-text {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kanban-label-delete {
    display: inline-flex;
    width: 22px;
    height: 22px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    color: var(--wx-color-font-alt);
  }

  .kanban-label-delete:hover,
  .kanban-label-delete:focus-visible {
    background: color-mix(in srgb, var(--wx-color-danger) 18%, transparent);
    color: var(--wx-color-danger);
    outline: none;
  }

  .kanban-label-delete :global(svg) {
    width: 13px;
    height: 13px;
  }

  .kanban-label-result:hover,
  .kanban-label-result-active {
    background: var(--wx-background-hover);
  }

  .kanban-label-create :global(svg) {
    width: 14px;
    height: 14px;
    color: var(--wx-color-primary);
  }

  .kanban-label-empty {
    color: var(--wx-color-font-alt);
    font-size: var(--wx-font-size-sm);
    padding: 8px;
  }
</style>
