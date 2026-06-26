/**
 * Sanitizes a persisted dockview layout blob before it is fed back into
 * `dock.fromJSON()` on restore. Two jobs:
 *
 *   1. Drop panels whose backing note no longer exists (deleted/trashed since
 *      the layout was saved), then prune any groups / grid nodes that are left
 *      empty as a result.
 *   2. Refresh each surviving panel's `component` + `title` from the live note
 *      so a note that changed kind/name is re-rendered correctly.
 *
 * Kept as plain functions (no Svelte/store deps) so the pruning rules can be
 * unit-tested directly — see dock-layout-restore.test.ts.
 */

export type SavedDockPanel = {
  component?: string;
  title?: string;
  params?: { noteId?: string };
};
export type SavedDockGroup = {
  views?: unknown;
  activeView?: unknown;
  [key: string]: unknown;
};
export type SavedDockNode = {
  type?: unknown;
  data?: unknown;
  [key: string]: unknown;
};
export type SavedDockBlob = {
  grid?: { root?: unknown; [key: string]: unknown };
  panels: Record<string, SavedDockPanel>;
  activeGroup?: unknown;
  floatingGroups?: unknown;
  popoutGroups?: unknown;
  edgeGroups?: unknown;
  [key: string]: unknown;
};

/** Live metadata for a still-existing note, used to refresh a saved panel. */
export interface ResolvedPanel {
  component: string;
  title: string;
}

/**
 * Resolves a note id to its current panel metadata, or `null` if the note no
 * longer exists (and the panel should therefore be pruned).
 */
export type ResolvePanel = (noteId: string) => ResolvedPanel | null;

export function sanitizeDockBlob(
  blob: unknown,
  resolve: ResolvePanel
): unknown | null {
  try {
    const json = cloneDockBlob(blob);
    if (!json) return null;
    const panels = json.panels;
    const validPanelIds = new Set<string>();
    let kept = 0;
    for (const [panelId, p] of Object.entries(panels)) {
      const noteId = p?.params?.noteId;
      const resolved = noteId ? resolve(noteId) : null;
      if (!noteId || !resolved) {
        delete panels[panelId];
        continue;
      }
      p.component = resolved.component;
      p.title = resolved.title;
      validPanelIds.add(panelId);
      kept += 1;
    }
    if (kept === 0) return null;
    if (json.grid) {
      json.grid.root = pruneDockNode(json.grid.root, validPanelIds);
      if (!json.grid.root) return null;
    }
    json.floatingGroups = pruneGroupArray(json.floatingGroups, validPanelIds);
    json.popoutGroups = pruneGroupArray(json.popoutGroups, validPanelIds);
    json.edgeGroups = pruneEdgeGroups(json.edgeGroups, validPanelIds);
    return json;
  } catch {
    return null;
  }
}

function cloneDockBlob(blob: unknown): SavedDockBlob | null {
  if (!blob || typeof blob !== 'object') return null;
  const cloned = JSON.parse(JSON.stringify(blob)) as SavedDockBlob;
  if (!cloned || typeof cloned !== 'object') return null;
  if (
    !cloned.panels ||
    typeof cloned.panels !== 'object' ||
    Array.isArray(cloned.panels)
  ) {
    return null;
  }
  return cloned;
}

function isSavedDockGroup(value: unknown): value is SavedDockGroup {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pruneDockGroup(
  group: unknown,
  validPanelIds: Set<string>
): SavedDockGroup | null {
  if (!isSavedDockGroup(group) || !Array.isArray(group.views)) return null;
  const views = group.views.filter(
    (id): id is string => typeof id === 'string' && validPanelIds.has(id)
  );
  if (views.length === 0) return null;
  group.views = views;
  if (
    typeof group.activeView !== 'string' ||
    !views.includes(group.activeView)
  ) {
    group.activeView = views[0];
  }
  return group;
}

function pruneDockNode(
  node: unknown,
  validPanelIds: Set<string>
): SavedDockNode | null {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const current = node as SavedDockNode;
  if (current.type === 'leaf') {
    const group = pruneDockGroup(current.data, validPanelIds);
    if (!group) return null;
    current.data = group;
    return current;
  }
  if (current.type === 'branch' && Array.isArray(current.data)) {
    const children = current.data
      .map((child) => pruneDockNode(child, validPanelIds))
      .filter((child): child is SavedDockNode => child !== null);
    if (children.length === 0) return null;
    // Keep the branch even when a single child survives. Dockview encodes
    // split orientation by node *depth* (it flips at every branch level), and
    // it requires the grid root to be a branch — `fromJSON` throws
    // "root must be of type branch" otherwise. Hoisting the sole child up a
    // level would both flip every descendant's orientation and, in the common
    // single-group case, leave a leaf at the root, making restore throw and
    // fall back to opening just one note.
    current.data = children;
    return current;
  }
  return null;
}

function pruneGroupArray(
  groups: unknown,
  validPanelIds: Set<string>
): unknown[] | undefined {
  if (!Array.isArray(groups)) return undefined;
  const pruned = groups
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const record = entry as { data?: unknown };
      const data = pruneDockGroup(record.data, validPanelIds);
      if (!data) return null;
      record.data = data;
      return record;
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  return pruned.length > 0 ? pruned : undefined;
}

function pruneEdgeGroups(
  edgeGroups: unknown,
  validPanelIds: Set<string>
): unknown {
  if (
    !edgeGroups ||
    typeof edgeGroups !== 'object' ||
    Array.isArray(edgeGroups)
  ) {
    return undefined;
  }
  const pruned: Record<string, unknown> = {};
  for (const [position, entry] of Object.entries(edgeGroups)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as { group?: unknown };
    if (!record.group) {
      pruned[position] = record;
      continue;
    }
    const group = pruneDockGroup(record.group, validPanelIds);
    if (!group) continue;
    record.group = group;
    pruned[position] = record;
  }
  return Object.keys(pruned).length > 0 ? pruned : undefined;
}
