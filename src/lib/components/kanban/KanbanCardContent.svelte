<script lang="ts">
  import { ExternalLink, FileQuestion } from '@lucide/svelte';
  import { noteKindIcon } from '$lib/components/note-kind-icon';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { requestOpenNote } from '$lib/stores/open-note-intent.svelte';
  import { tree } from '$lib/stores/tree.svelte';
  import { getPriorityOptions } from '@svar-ui/svelte-kanban';
  import type { CardShape, KanbanCard } from '@svar-ui/svelte-kanban';

  interface Props {
    card: KanbanCard & {
      linkedNoteId?: string;
      tags?: string[];
      users?: string[];
    };
    cardShape: CardShape;
  }

  let { card, cardShape }: Props = $props();

  function configOf<T>(shape: boolean | T | undefined): T | undefined {
    return typeof shape === 'object' && shape !== null ? shape : undefined;
  }

  function resolveItem(
    id: unknown,
    collection: Array<{
      id: string | number;
      label: string;
      color?: string;
      css?: string;
    }> = []
  ) {
    if (typeof id !== 'string' && typeof id !== 'number') return null;
    return (
      collection.find((item) => item.id === id) ?? { id, label: String(id) }
    );
  }

  function toDate(value: unknown): Date | null {
    if (value instanceof Date)
      return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'string' || typeof value === 'number') {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
  }

  function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
  }

  function formatDeadline(value: unknown, format?: string): string | null {
    const date = toDate(value);
    if (!date) return null;
    if (!format) return date.toLocaleDateString();
    return format
      .replace(/YYYY/g, String(date.getFullYear()))
      .replace(/MM/g, pad2(date.getMonth() + 1))
      .replace(/DD/g, pad2(date.getDate()))
      .replace(/HH/g, pad2(date.getHours()))
      .replace(/mm/g, pad2(date.getMinutes()));
  }

  const priorityConfig = $derived(configOf(cardShape.priority));
  const tagConfig = $derived(configOf(cardShape.tags));
  const userConfig = $derived(configOf(cardShape.users));
  const deadlineConfig = $derived(configOf(cardShape.deadline));
  const progressConfig = $derived(configOf(cardShape.progress));
  const priority = $derived(
    cardShape.priority
      ? resolveItem(card.priority, priorityConfig?.data ?? getPriorityOptions())
      : null
  );
  const labels = $derived(
    cardShape.tags && Array.isArray(card.tags)
      ? card.tags
          .map((id) => resolveItem(id, tagConfig?.data))
          .filter((item): item is NonNullable<typeof item> => Boolean(item))
      : []
  );
  const users = $derived(
    cardShape.users && Array.isArray(card.users)
      ? card.users
          .map((id) => resolveItem(id, userConfig?.data))
          .filter((item): item is NonNullable<typeof item> => Boolean(item))
      : []
  );
  const linkedNote = $derived(
    card.linkedNoteId ? tree.notesById[card.linkedNoteId] : undefined
  );
  const LinkedNoteIcon = $derived(
    linkedNote ? noteKindIcon(linkedNote.note_kind) : FileQuestion
  );
  const deadline = $derived(
    cardShape.deadline
      ? formatDeadline(card.deadline, deadlineConfig?.format)
      : null
  );
  const progressPercent = $derived(
    Math.round(Math.max(0, Math.min(1, Number(card.progress ?? 0))) * 100)
  );

  function openLinkedNote(event: MouseEvent | PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (card.linkedNoteId && linkedNote && !linkedNote.trashed) {
      requestOpenNote(card.linkedNoteId);
    }
  }
</script>

{#if priority || deadline}
  <div class="kanban-card-header">
    {#if priority}
      <span class="kanban-card-priority {priority.css ?? ''}">
        {priority.label}
      </span>
    {/if}
    {#if deadline}
      <span class="kanban-card-deadline">{deadline}</span>
    {/if}
  </div>
{/if}

<div class="kanban-card-body">
  {#if card.label}
    <div class="kanban-card-title">{card.label}</div>
  {/if}

  {#if card.description && cardShape.description}
    <p class="kanban-card-description">{card.description}</p>
  {/if}

  {#if labels.length > 0}
    <div class="kanban-card-labels">
      {#each labels as label (label.id)}
        <span
          class="kanban-card-label"
          style:border-color={label.color ?? 'var(--wx-color-primary)'}
          style:background={label.color
            ? `color-mix(in srgb, ${label.color} 18%, transparent)`
            : 'var(--wx-kanban-tag-bg)'}
        >
          <span
            class="kanban-card-label-dot"
            style:background={label.color ?? 'var(--wx-color-primary)'}
            aria-hidden="true"
          ></span>
          {label.label}
        </span>
      {/each}
    </div>
  {/if}

  {#if card.linkedNoteId}
    <button
      type="button"
      class="kanban-card-linked-note"
      class:kanban-card-linked-note-missing={!linkedNote || linkedNote.trashed}
      aria-label={tUi('editor.kanban.openLinkedNote')}
      title={linkedNote?.title ?? tUi('editor.kanban.missingLinkedNote')}
      onpointerdown={openLinkedNote}
      onclick={openLinkedNote}
      disabled={!linkedNote || linkedNote.trashed}
    >
      <LinkedNoteIcon aria-hidden="true" />
      <span>
        {linkedNote?.title || tUi('editor.kanban.missingLinkedNote')}
      </span>
      {#if linkedNote && !linkedNote.trashed}
        <ExternalLink aria-hidden="true" />
      {/if}
    </button>
  {/if}

  {#if Number(card.progress ?? 0) > 0 && cardShape.progress}
    <div class="kanban-card-progress-row">
      <div class="kanban-card-progress" aria-label="Progress">
        <div
          class="kanban-card-progress-fill"
          style:width={`${progressPercent}%`}
        ></div>
      </div>
      {#if progressConfig?.showLabel}
        <span class="kanban-card-progress-label">{progressPercent}%</span>
      {/if}
    </div>
  {/if}
</div>

{#if users.length > 0}
  <div class="kanban-card-footer">
    <div class="kanban-card-users" aria-label="Users">
      {#each users.slice(0, 4) as user (user.id)}
        <span class="kanban-card-user" title={user.label}>
          {user.label.slice(0, 1).toUpperCase()}
        </span>
      {/each}
      {#if users.length > 4}
        <span class="kanban-card-user kanban-card-user-more">
          +{users.length - 4}
        </span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .kanban-card-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--wx-font-size-sm);
  }

  .kanban-card-priority {
    border-radius: var(--wx-border-radius);
    background: var(--wx-kanban-tag-bg);
    font-weight: var(--wx-font-weight-md);
    padding: 1px 6px;
  }

  .kanban-card-header :global(.wx-card-priority-low) {
    background: var(--wx-kanban-priority-low-bg);
    color: var(--wx-kanban-priority-low-color);
  }

  .kanban-card-header :global(.wx-card-priority-medium) {
    background: var(--wx-kanban-priority-medium-bg);
    color: var(--wx-kanban-priority-medium-color);
  }

  .kanban-card-header :global(.wx-card-priority-high) {
    background: var(--wx-kanban-priority-high-bg);
    color: var(--wx-kanban-priority-high-color);
  }

  .kanban-card-deadline {
    margin-left: auto;
    color: var(--wx-color-font-alt);
  }

  .kanban-card-body {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 6px;
  }

  .kanban-card-title {
    color: var(--wx-color-font);
    font-size: var(--wx-font-size);
    font-weight: var(--wx-font-weight-md);
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .kanban-card-description {
    display: -webkit-box;
    margin: 0;
    overflow: hidden;
    color: var(--wx-color-font-alt);
    font-size: var(--wx-font-size-sm);
    line-height: 1.35;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }

  .kanban-card-labels {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .kanban-card-label {
    display: inline-flex;
    max-width: 100%;
    align-items: center;
    gap: 5px;
    border: 1px solid transparent;
    border-radius: 999px;
    color: var(--wx-color-font);
    font-size: var(--wx-font-size-sm);
    line-height: 1.25;
    padding: 2px 7px 2px 5px;
  }

  .kanban-card-label-dot {
    width: 7px;
    height: 7px;
    flex: 0 0 auto;
    border-radius: 999px;
  }

  .kanban-card-linked-note {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 6px;
    border: 1px solid
      color-mix(
        in srgb,
        var(--wx-kanban-border-color) 78%,
        var(--wx-color-primary)
      );
    border-radius: 5px;
    background: color-mix(
      in srgb,
      var(--wx-kanban-card-bg) 92%,
      var(--wx-color-primary)
    );
    color: var(--wx-color-font);
    cursor: pointer;
    font: inherit;
    font-size: var(--wx-font-size-sm);
    line-height: 1.25;
    padding: 5px 7px;
    text-align: left;
  }

  .kanban-card-linked-note:hover:not(:disabled) {
    border-color: color-mix(
      in srgb,
      var(--wx-kanban-border-color) 55%,
      var(--wx-color-primary)
    );
    background: color-mix(
      in srgb,
      var(--wx-kanban-card-bg) 86%,
      var(--wx-color-primary)
    );
  }

  .kanban-card-linked-note:disabled {
    cursor: default;
    opacity: 0.75;
  }

  .kanban-card-linked-note :global(svg) {
    width: 14px;
    height: 14px;
    flex: 0 0 auto;
  }

  .kanban-card-linked-note span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kanban-card-linked-note-missing {
    color: var(--wx-color-font-alt);
  }

  .kanban-card-progress-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .kanban-card-progress {
    height: 4px;
    flex: 1;
    overflow: hidden;
    border-radius: 999px;
    background: var(--wx-kanban-progress-bg);
  }

  .kanban-card-progress-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--wx-kanban-progress-fill);
  }

  .kanban-card-progress-label {
    color: var(--wx-color-font-alt);
    font-size: var(--wx-font-size-sm);
  }

  .kanban-card-footer {
    display: flex;
    justify-content: flex-end;
  }

  .kanban-card-users {
    display: flex;
    align-items: center;
  }

  .kanban-card-user {
    display: inline-flex;
    width: 22px;
    height: 22px;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--wx-kanban-card-bg);
    border-radius: 999px;
    background: var(--wx-kanban-avatar-bg);
    color: var(--wx-color-font);
    font-size: 11px;
    font-weight: 600;
  }

  .kanban-card-user + .kanban-card-user {
    margin-left: -6px;
  }
</style>
