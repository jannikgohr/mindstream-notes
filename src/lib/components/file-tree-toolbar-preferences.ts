export const FILE_TREE_TOOLBAR_STORAGE_KEY =
  'notes-app:file-tree-create-toolbar:v1';

export const CORE_FILE_TREE_ACTION_IDS = [
  'note',
  'folder',
  'drawing',
  'ink',
  'kanban',
  'pdf'
] as const;

export type CoreFileTreeActionId = (typeof CORE_FILE_TREE_ACTION_IDS)[number];

export interface FileTreeToolbarPreferences {
  toolbar: string[];
  more: string[];
}

export const DEFAULT_FILE_TREE_TOOLBAR_PREFERENCES: FileTreeToolbarPreferences =
  {
    toolbar: ['note', 'folder', 'drawing'],
    more: ['ink', 'pdf', 'kanban']
  };

export const LEGACY_FILE_TREE_TOOLBAR_PREFERENCES: FileTreeToolbarPreferences =
  {
    toolbar: ['folder', 'drawing', 'ink', 'kanban', 'pdf', 'note'],
    more: []
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((item): item is string => typeof item === 'string'))
  ];
}

export function normalizeFileTreeToolbarPreferences(
  value: unknown,
  availableIds: readonly string[],
  fallback = DEFAULT_FILE_TREE_TOOLBAR_PREFERENCES
): FileTreeToolbarPreferences {
  const parsed = isRecord(value)
    ? {
        toolbar: uniqueStrings(value.toolbar),
        more: uniqueStrings(value.more)
      }
    : {
        toolbar: [...fallback.toolbar],
        more: [...fallback.more]
      };
  const known = new Set(availableIds);
  const toolbar = parsed.toolbar.filter((id) => known.has(id));
  const toolbarSet = new Set(toolbar);
  const more = parsed.more.filter((id) => known.has(id) && !toolbarSet.has(id));
  const placed = new Set([...toolbar, ...more]);

  for (const id of availableIds) {
    if (!placed.has(id)) more.push(id);
  }

  if (toolbar.length === 0 && availableIds.length > 0) {
    const noteIndex = more.indexOf('note');
    const fallbackIndex = noteIndex >= 0 ? noteIndex : 0;
    toolbar.push(more.splice(fallbackIndex, 1)[0]);
  }

  return { toolbar, more };
}

function hasExistingAppData(): boolean {
  if (typeof localStorage === 'undefined') return false;
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (
      key?.startsWith('notes-app:') &&
      key !== FILE_TREE_TOOLBAR_STORAGE_KEY
    ) {
      return true;
    }
  }
  return false;
}

export function loadFileTreeToolbarPreferences(
  availableIds: readonly string[]
): FileTreeToolbarPreferences {
  if (typeof localStorage === 'undefined') {
    return normalizeFileTreeToolbarPreferences(null, availableIds);
  }
  try {
    const raw = localStorage.getItem(FILE_TREE_TOOLBAR_STORAGE_KEY);
    if (raw) {
      return normalizeFileTreeToolbarPreferences(JSON.parse(raw), availableIds);
    }
    const fallback = hasExistingAppData()
      ? LEGACY_FILE_TREE_TOOLBAR_PREFERENCES
      : DEFAULT_FILE_TREE_TOOLBAR_PREFERENCES;
    return normalizeFileTreeToolbarPreferences(null, availableIds, fallback);
  } catch {
    return normalizeFileTreeToolbarPreferences(null, availableIds);
  }
}

export function saveFileTreeToolbarPreferences(
  preferences: FileTreeToolbarPreferences
): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      FILE_TREE_TOOLBAR_STORAGE_KEY,
      JSON.stringify(preferences)
    );
  } catch (error) {
    console.warn('[file-tree-toolbar] save failed', error);
  }
}

export function moveFileTreeToolbarAction(
  preferences: FileTreeToolbarPreferences,
  actionId: string,
  destination: keyof FileTreeToolbarPreferences,
  beforeId?: string
): FileTreeToolbarPreferences {
  const toolbar = preferences.toolbar.filter((id) => id !== actionId);
  const more = preferences.more.filter((id) => id !== actionId);
  const target = destination === 'toolbar' ? toolbar : more;
  const beforeIndex = beforeId ? target.indexOf(beforeId) : -1;
  target.splice(beforeIndex >= 0 ? beforeIndex : target.length, 0, actionId);
  return { toolbar, more };
}
