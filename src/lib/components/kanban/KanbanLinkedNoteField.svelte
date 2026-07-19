<script lang="ts">
  import { ExternalLink, FileQuestion, Search, X } from '@lucide/svelte';
  import { noteKindIcon } from '$lib/components/note-kind-icon';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { requestOpenNote } from '$lib/stores/open-note-intent.svelte';

  export interface KanbanNoteOption {
    id: string;
    label: string;
    note_kind?: string;
    path?: string;
    modified?: string;
    duplicateTitle?: boolean;
    trashed?: boolean;
  }

  interface Props {
    value?: string;
    options?: KanbanNoteOption[];
    disabled?: boolean;
    error?: boolean;
    placeholder?: string;
    onchange?: (ev: { value: string; input?: boolean }) => void;
  }

  let {
    value = '',
    options = [],
    disabled = false,
    error = false,
    placeholder = tUi('editor.kanban.linkedNotePlaceholder'),
    onchange
  }: Props = $props();

  const MAX_RESULTS = 8;

  let root = $state<HTMLDivElement | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);
  let open = $state(false);
  let query = $state('');
  let highlight = $state(0);

  const selected = $derived(
    value ? options.find((option) => option.id === value) : undefined
  );

  const results = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const available = options.filter((option) => !option.trashed);
    if (!q) {
      return [...available]
        .sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''))
        .slice(0, MAX_RESULTS);
    }
    return available
      .map((option) => {
        const title = option.label.toLowerCase();
        const idx = title.indexOf(q);
        if (idx < 0) return null;
        return {
          option,
          rank: idx === 0 ? 0 : idx + title.length / 1000
        };
      })
      .filter((entry): entry is { option: KanbanNoteOption; rank: number } =>
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

  function select(option: KanbanNoteOption): void {
    onchange?.({ value: option.id, input: true });
    query = '';
    open = false;
  }

  function clear(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    onchange?.({ value: '', input: true });
    query = '';
    open = false;
    inputEl?.focus();
  }

  function openLinkedNote(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (value) requestOpenNote(value);
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
    } else if (event.key === 'Enter' && open) {
      const picked = results[highlight] ?? results[0];
      if (picked) select(picked);
      event.preventDefault();
    } else if (event.key === 'Escape') {
      open = false;
      event.preventDefault();
    }
  }
</script>

<div
  class="kanban-note-field"
  class:kanban-note-field-error={error}
  class:kanban-note-field-disabled={disabled}
  bind:this={root}
>
  <div class="kanban-note-input-row">
    <Search class="kanban-note-search" aria-hidden="true" />
    <input
      bind:this={inputEl}
      type="text"
      value={open ? query : (selected?.label ?? '')}
      {placeholder}
      {disabled}
      onfocus={() => {
        open = true;
        query = '';
        highlight = 0;
      }}
      oninput={(event) => {
        query = event.currentTarget.value;
        open = true;
        highlight = 0;
      }}
      onkeydown={handleKeydown}
    />
    {#if value}
      <button
        type="button"
        class="kanban-note-icon-button"
        aria-label={tUi('editor.kanban.openLinkedNote')}
        title={tUi('editor.kanban.openLinkedNote')}
        onclick={openLinkedNote}
        disabled={disabled || !selected}
      >
        <ExternalLink aria-hidden="true" />
      </button>
      <button
        type="button"
        class="kanban-note-icon-button"
        aria-label={tUi('editor.kanban.unlinkNote')}
        title={tUi('editor.kanban.unlinkNote')}
        onclick={clear}
        {disabled}
      >
        <X aria-hidden="true" />
      </button>
    {/if}
  </div>

  {#if value && !selected}
    <div class="kanban-note-missing">
      <FileQuestion aria-hidden="true" />
      {tUi('editor.kanban.missingLinkedNote')}
    </div>
  {/if}

  {#if open && !disabled}
    <div class="kanban-note-results" role="listbox">
      {#if results.length > 0}
        {#each results as option, index (option.id)}
          {@const Icon = noteKindIcon(option.note_kind)}
          <button
            type="button"
            class="kanban-note-result"
            class:kanban-note-result-active={index === highlight}
            role="option"
            aria-selected={index === highlight}
            onmouseenter={() => (highlight = index)}
            onclick={() => select(option)}
          >
            <Icon class="kanban-note-result-icon" aria-hidden="true" />
            <span class="kanban-note-result-copy">
              <span class="kanban-note-result-title">{option.label}</span>
              {#if option.path || option.duplicateTitle}
                <span class="kanban-note-result-path">
                  {option.path || tUi('editor.kanban.duplicateNoteTitle')}
                </span>
              {/if}
            </span>
          </button>
        {/each}
      {:else}
        <div class="kanban-note-empty">{tUi('editor.kanban.noNotes')}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .kanban-note-field {
    position: relative;
    width: 100%;
  }

  .kanban-note-input-row {
    display: flex;
    min-height: var(--wx-input-height);
    align-items: center;
    gap: 6px;
    border: var(--wx-input-border);
    border-radius: var(--wx-input-border-radius);
    background: var(--wx-input-background);
    color: var(--wx-input-font-color);
    padding: 0 6px;
  }

  .kanban-note-field:focus-within .kanban-note-input-row {
    border: var(--wx-input-border-focus);
  }

  .kanban-note-field-error .kanban-note-input-row {
    border-color: var(--wx-color-danger);
  }

  .kanban-note-field-disabled {
    opacity: 0.7;
  }

  :global(.kanban-note-search) {
    width: 15px;
    height: 15px;
    flex: 0 0 auto;
    color: var(--wx-input-icon-color);
  }

  input {
    min-width: 0;
    flex: 1;
    border: 0;
    outline: none;
    background: transparent;
    color: inherit;
    font: inherit;
    line-height: var(--wx-input-line-height);
    padding: var(--wx-input-padding);
    padding-left: 0;
  }

  input::placeholder {
    color: var(--wx-input-placeholder-color);
  }

  .kanban-note-icon-button {
    display: inline-flex;
    width: 24px;
    height: 24px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--wx-input-icon-color);
    cursor: pointer;
  }

  .kanban-note-icon-button:hover:not(:disabled) {
    background: var(--wx-background-hover);
    color: var(--wx-input-font-color);
  }

  .kanban-note-icon-button :global(svg) {
    width: 15px;
    height: 15px;
  }

  .kanban-note-results {
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
    box-shadow: var(--wx-popup-shadow);
    padding: 4px;
  }

  .kanban-note-result {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 8px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--wx-color-font);
    cursor: pointer;
    padding: 6px 8px;
    text-align: left;
  }

  .kanban-note-result:hover,
  .kanban-note-result-active {
    background: var(--wx-background-hover);
  }

  :global(.kanban-note-result-icon) {
    width: 16px;
    height: 16px;
    flex: 0 0 auto;
    color: var(--wx-color-font-alt);
  }

  .kanban-note-result-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .kanban-note-result-title,
  .kanban-note-result-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kanban-note-result-title {
    font-weight: 600;
  }

  .kanban-note-result-path,
  .kanban-note-empty,
  .kanban-note-missing {
    color: var(--wx-color-font-alt);
    font-size: var(--wx-font-size-sm);
  }

  .kanban-note-empty {
    padding: 8px;
  }

  .kanban-note-missing {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
  }

  .kanban-note-missing :global(svg) {
    width: 14px;
    height: 14px;
  }
</style>
