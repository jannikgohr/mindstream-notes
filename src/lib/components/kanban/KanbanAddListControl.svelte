<script lang="ts">
  import { Plus } from '@lucide/svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    resolveInlineListEdit,
    type InlineListEditTrigger
  } from './inline-list-edit';

  interface Props {
    creating: boolean;
    onStart: () => void;
    onCommit: (value: string) => void;
    onCancel: () => void;
  }

  let { creating, onStart, onCommit, onCancel }: Props = $props();
  let input = $state<HTMLInputElement | null>(null);
  let value = $state('');

  $effect(() => {
    if (!creating) {
      value = '';
      return;
    }
    queueMicrotask(() => input?.focus());
  });

  function finish(trigger: InlineListEditTrigger): void {
    const result = resolveInlineListEdit(value, trigger);
    if (result.type === 'commit') onCommit(result.value);
    else onCancel();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    finish(event.key === 'Enter' ? 'enter' : 'escape');
  }
</script>

<div class="add-list-control">
  {#if creating}
    <input
      bind:this={input}
      bind:value
      class="add-list-input"
      aria-label={tUi('editor.kanban.addList')}
      placeholder={tUi('editor.kanban.newList')}
      onkeydown={handleKeydown}
      onblur={() => finish('blur')}
    />
  {:else}
    <button type="button" class="add-list-button" onclick={onStart}>
      <Plus aria-hidden="true" />
      <span>{tUi('editor.kanban.addList')}</span>
    </button>
  {/if}
</div>

<style>
  .add-list-control {
    flex: 0 0 280px;
    align-self: flex-start;
  }

  .add-list-button,
  .add-list-input {
    width: 100%;
    min-height: 3rem;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    background: var(--muted);
    color: var(--muted-foreground);
  }

  .add-list-button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.875rem;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .add-list-button:focus {
    outline: none;
  }

  .add-list-button :global(svg) {
    width: 1rem;
    height: 1rem;
  }

  .add-list-input {
    border-style: solid;
    border-color: var(--ring);
    background: var(--background);
    padding: 0 0.75rem;
    color: var(--foreground);
    font-size: 0.875rem;
    font-weight: 600;
    outline: none;
    box-shadow: 0 0 0 1px var(--ring);
  }
</style>
