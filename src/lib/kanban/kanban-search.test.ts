import { describe, expect, it } from 'vitest';
import {
  EMPTY_KANBAN_SEARCH_FILTERS,
  KANBAN_SEARCH_FILTER_TAG,
  applyKanbanSearchFilter,
  hasActiveKanbanSearchFilters,
  kanbanCardSearchText,
  matchesKanbanSearchFilters,
  widgetCardToSearchCard,
  type KanbanFilterApi,
  type KanbanSearchLookups
} from './kanban-search';
import type { KanbanCardData } from './kanban-yjs';

const lookups: KanbanSearchLookups = {
  columns: [
    { id: 'todo', label: 'To Do', order: 0 },
    { id: 'done', label: 'Done', order: 1 }
  ],
  labels: [
    { id: 'ui', label: 'UI', color: '#3b82f6', order: 0 },
    { id: 'bug', label: 'Bug', color: '#ef4444', order: 1 }
  ],
  notes: [{ id: 'note-1', label: 'Release Plan', path: 'Projects' }],
  priorities: [
    { id: 1, label: 'Low' },
    { id: 2, label: 'Medium' },
    { id: 3, label: 'High' }
  ]
};

const card: KanbanCardData = {
  id: 'card-1',
  label: 'Fix card menu',
  column: 'todo',
  description: 'Keep popovers below settings',
  priority: 3,
  tags: ['ui', 'bug'],
  users: ['janni'],
  linkedNoteId: 'note-1',
  order: 0
};

describe('kanban search filters', () => {
  it('builds searchable text from card fields and lookup labels', () => {
    expect(kanbanCardSearchText(card, lookups)).toContain('Fix card menu');
    expect(kanbanCardSearchText(card, lookups)).toContain('To Do');
    expect(kanbanCardSearchText(card, lookups)).toContain('UI');
    expect(kanbanCardSearchText(card, lookups)).toContain('Release Plan');
  });

  it('matches text queries case-insensitively', () => {
    expect(
      matchesKanbanSearchFilters(
        card,
        { ...EMPTY_KANBAN_SEARCH_FILTERS, query: 'SETTINGS' },
        lookups
      )
    ).toBe(true);
    expect(
      matchesKanbanSearchFilters(
        card,
        { ...EMPTY_KANBAN_SEARCH_FILTERS, query: 'unrelated' },
        lookups
      )
    ).toBe(false);
  });

  it('combines structured filters with AND semantics', () => {
    expect(
      matchesKanbanSearchFilters(
        card,
        {
          ...EMPTY_KANBAN_SEARCH_FILTERS,
          columns: ['todo'],
          priorities: [3],
          labels: ['ui', 'bug'],
          users: ['janni'],
          linkedOnly: true
        },
        lookups
      )
    ).toBe(true);
    expect(
      matchesKanbanSearchFilters(
        card,
        { ...EMPTY_KANBAN_SEARCH_FILTERS, labels: ['ui', 'missing'] },
        lookups
      )
    ).toBe(false);
  });

  it('reports whether any filter is active', () => {
    expect(hasActiveKanbanSearchFilters(EMPTY_KANBAN_SEARCH_FILTERS)).toBe(
      false
    );
    expect(
      hasActiveKanbanSearchFilters({
        ...EMPTY_KANBAN_SEARCH_FILTERS,
        linkedOnly: true
      })
    ).toBe(true);
  });

  it('normalizes widget cards before matching', () => {
    expect(
      widgetCardToSearchCard({
        id: 42,
        label: 'Widget card',
        column: 'todo',
        priority: 2,
        tags: ['ui'],
        users: ['janni'],
        linkedNoteId: 'note-1'
      })
    ).toMatchObject({
      id: '42',
      label: 'Widget card',
      column: 'todo',
      priority: 2,
      tags: ['ui'],
      users: ['janni'],
      linkedNoteId: 'note-1'
    });
  });

  it('clears the tagged SVAR filter when no search filters are active', () => {
    const calls: Array<Parameters<KanbanFilterApi['exec']>> = [];
    const api: KanbanFilterApi = {
      exec: (...args) => {
        calls.push(args);
      }
    };

    applyKanbanSearchFilter(api, EMPTY_KANBAN_SEARCH_FILTERS, lookups);

    expect(calls).toEqual([
      ['filter-cards', { tag: KANBAN_SEARCH_FILTER_TAG }]
    ]);
  });

  it('installs a tagged SVAR filter predicate when search filters are active', () => {
    const calls: Array<Parameters<KanbanFilterApi['exec']>> = [];
    const api: KanbanFilterApi = {
      exec: (...args) => {
        calls.push(args);
      }
    };

    applyKanbanSearchFilter(
      api,
      { ...EMPTY_KANBAN_SEARCH_FILTERS, query: 'release', linkedOnly: true },
      lookups
    );

    expect(calls[0][0]).toBe('filter-cards');
    expect(calls[0][1].tag).toBe(KANBAN_SEARCH_FILTER_TAG);
    expect(calls[0][1].filter).toBeTypeOf('function');
    expect(calls[0][1].filter?.({ ...card })).toBe(true);
    expect(calls[0][1].filter?.({ ...card, linkedNoteId: undefined })).toBe(
      false
    );
  });
});
