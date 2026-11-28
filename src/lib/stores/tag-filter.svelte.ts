import type { NoteSummary, TreeNode } from '$lib/api';
import { compareLabels } from '$lib/utils';

// In memory on purpose: a filter that survived a restart would hide notes
// with nothing on screen to explain why.
export const tagFilter = $state<{ tags: string[] }>({ tags: [] });

export function toggleTagFilter(tag: string) {
  tagFilter.tags = tagFilter.tags.includes(tag)
    ? tagFilter.tags.filter((t) => t !== tag)
    : [...tagFilter.tags, tag];
}

export function clearTagFilter() {
  tagFilter.tags = [];
}

// Mounted filter controls. A plugin view such as Journal, or a collapsed
// sidebar, has none, and a note created there shouldn't get tags the user
// can't see a reason for.
let shownControls = 0;

/** Call on mount; returns the unmount half. */
export function showTagFilterControl(): () => void {
  shownControls++;
  let shown = true;
  return () => {
    if (shown) shownControls--;
    shown = false;
  };
}

/** The tags a new note takes so it stays in the filtered view. */
export function tagsForNewNote(): readonly string[] {
  return shownControls > 0 ? tagFilter.tags : [];
}

/** A note matches when it has every selected tag; `work` covers `work/urgent`. */
function noteHasTags(noteTags: readonly string[], selected: readonly string[]) {
  return selected.every((s) =>
    noteTags.some((t) => t === s || t.startsWith(`${s}/`))
  );
}

/** Keeps matching notes and the folders that lead to them. */
export function filterNodesByTags(
  nodes: TreeNode[],
  notesById: Record<string, NoteSummary>,
  selected: readonly string[]
): TreeNode[] {
  if (selected.length === 0) return nodes;
  const out: TreeNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'note') {
      const note = notesById[node.id];
      if (note && noteHasTags(note.tags, selected)) out.push(node);
      continue;
    }
    const children = filterNodesByTags(node.children, notesById, selected);
    if (children.length > 0) out.push({ ...node, children });
  }
  return out;
}

export interface TagFilterOption {
  path: string;
  segment: string;
  depth: number;
}

/**
 * Every tag and its parent paths, each parent followed by its children.
 * A parent is selectable even when no note carries it alone.
 */
export function tagFilterOptions(tags: Iterable<string>): TagFilterOption[] {
  const paths = new Set<string>();
  for (const tag of tags) {
    const segments = tag.split('/');
    for (let i = 1; i <= segments.length; i++) {
      paths.add(segments.slice(0, i).join('/'));
    }
  }
  return [...paths]
    .map((path) => path.split('/'))
    .sort((a, b) => {
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const order = compareLabels(a[i], b[i]);
        if (order !== 0) return order;
      }
      return a.length - b.length;
    })
    .map((segments) => ({
      path: segments.join('/'),
      segment: segments[segments.length - 1],
      depth: segments.length - 1
    }));
}
