import type {
  KanbanCardData,
  KanbanColumnData,
  KanbanLabelData
} from './kanban-yjs';

export const KANBAN_SEARCH_FILTER_TAG = 'mindstream-kanban-search';

export interface KanbanSearchFilters {
  query: string;
  columns: string[];
  priorities: number[];
  labels: string[];
  users: string[];
  linkedOnly: boolean;
}

export interface KanbanSearchLookups {
  columns?: KanbanColumnData[];
  labels?: KanbanLabelData[];
  notes?: { id: string; label: string; path?: string }[];
  priorities?: { id: number; label: string }[];
}

export const EMPTY_KANBAN_SEARCH_FILTERS: KanbanSearchFilters = {
  query: '',
  columns: [],
  priorities: [],
  labels: [],
  users: [],
  linkedOnly: false
};

function textIncludes(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

function mapById<T extends { id: string | number }>(
  items: T[] | undefined
): Map<string, T> {
  return new Map((items ?? []).map((item) => [String(item.id), item]));
}

export function hasActiveKanbanSearchFilters(
  filters: KanbanSearchFilters
): boolean {
  return (
    filters.query.trim().length > 0 ||
    filters.columns.length > 0 ||
    filters.priorities.length > 0 ||
    filters.labels.length > 0 ||
    filters.users.length > 0 ||
    filters.linkedOnly
  );
}

export function kanbanCardSearchText(
  card: KanbanCardData,
  lookups: KanbanSearchLookups = {}
): string {
  const columns = mapById(lookups.columns);
  const labels = mapById(lookups.labels);
  const notes = mapById(lookups.notes);
  const priorities = mapById(lookups.priorities);
  const linkedNote = card.linkedNoteId
    ? notes.get(card.linkedNoteId)
    : undefined;

  return [
    card.label,
    card.description,
    columns.get(card.column)?.label,
    card.priority ? priorities.get(String(card.priority))?.label : undefined,
    ...(card.tags ?? []).map((id) => labels.get(id)?.label ?? id),
    ...(card.users ?? []),
    linkedNote?.label,
    linkedNote?.path
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ');
}

export function matchesKanbanSearchFilters(
  card: KanbanCardData,
  filters: KanbanSearchFilters,
  lookups: KanbanSearchLookups = {}
): boolean {
  const query = filters.query.trim();
  if (query && !textIncludes(kanbanCardSearchText(card, lookups), query)) {
    return false;
  }
  if (filters.columns.length > 0 && !filters.columns.includes(card.column)) {
    return false;
  }
  if (
    filters.priorities.length > 0 &&
    (card.priority == null || !filters.priorities.includes(card.priority))
  ) {
    return false;
  }
  if (
    filters.labels.length > 0 &&
    !filters.labels.every((id) => card.tags?.includes(id))
  ) {
    return false;
  }
  if (
    filters.users.length > 0 &&
    !filters.users.every((id) => card.users?.includes(id))
  ) {
    return false;
  }
  if (filters.linkedOnly && !card.linkedNoteId) return false;
  return true;
}

export interface KanbanFilterApi {
  exec: (
    action: 'filter-cards',
    payload: {
      tag: string;
      filter?: (card: Record<string, unknown>) => boolean;
    }
  ) => void;
}

export function widgetCardToSearchCard(
  card: Record<string, unknown>
): KanbanCardData {
  const rawDeadline = card.deadline;
  const deadline =
    rawDeadline instanceof Date
      ? rawDeadline
      : typeof rawDeadline === 'string'
        ? new Date(rawDeadline)
        : undefined;
  return {
    id: String(card.id),
    label: typeof card.label === 'string' ? card.label : '',
    column: typeof card.column === 'string' ? card.column : '',
    description:
      typeof card.description === 'string' ? card.description : undefined,
    priority: typeof card.priority === 'number' ? card.priority : undefined,
    progress: typeof card.progress === 'number' ? card.progress : undefined,
    deadline:
      deadline && !Number.isNaN(deadline.getTime()) ? deadline : undefined,
    tags: Array.isArray(card.tags) ? card.tags.map(String) : undefined,
    users: Array.isArray(card.users) ? card.users.map(String) : undefined,
    linkedNoteId:
      typeof card.linkedNoteId === 'string' ? card.linkedNoteId : undefined,
    order: 0
  };
}

export function applyKanbanSearchFilter(
  api: KanbanFilterApi,
  filters: KanbanSearchFilters,
  lookups: KanbanSearchLookups,
  tag = KANBAN_SEARCH_FILTER_TAG
): void {
  if (!hasActiveKanbanSearchFilters(filters)) {
    api.exec('filter-cards', { tag });
    return;
  }
  api.exec('filter-cards', {
    tag,
    filter: (card) =>
      matchesKanbanSearchFilters(widgetCardToSearchCard(card), filters, lookups)
  });
}
