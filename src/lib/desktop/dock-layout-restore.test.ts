import { describe, expect, it } from 'vitest';
import { sanitizeDockBlob, type ResolvePanel } from './dock-layout-restore';

/** Resolver that accepts every note id (nothing pruned for existence). */
const resolveAll: ResolvePanel = (noteId) => ({
  component: 'noteEditor',
  title: noteId.toUpperCase()
});

/** Resolver that only knows the ids in `known`. */
const resolveOnly =
  (known: string[]): ResolvePanel =>
  (noteId) =>
    known.includes(noteId)
      ? { component: 'noteEditor', title: noteId.toUpperCase() }
      : null;

function panel(noteId: string) {
  return {
    id: `note:${noteId}`,
    component: 'noteEditor',
    title: noteId,
    params: { noteId }
  };
}

/** A single tab strip holding every note id — the common case. */
function singleGroupBlob(noteIds: string[]) {
  const views = noteIds.map((id) => `note:${id}`);
  return {
    grid: {
      root: {
        type: 'branch',
        data: [
          {
            type: 'leaf',
            data: { id: 'group-1', views, activeView: views[0] },
            size: 600
          }
        ],
        size: 800
      },
      width: 800,
      height: 600,
      orientation: 0
    },
    panels: Object.fromEntries(noteIds.map((id) => [`note:${id}`, panel(id)])),
    activeGroup: 'group-1'
  };
}

type Node = { type?: unknown; data?: unknown };

describe('sanitizeDockBlob', () => {
  it('keeps the grid root a branch for a single restored group', () => {
    // Regression: pruneDockNode used to hoist a sole surviving child up a
    // level, turning the root into a leaf. Dockview's fromJSON then throws
    // "root must be of type branch", restore falls back, and only one note
    // (the first in the tree) is reopened.
    const sanitized = sanitizeDockBlob(
      singleGroupBlob(['a', 'b', 'c']),
      resolveAll
    ) as { grid: { root: Node } };

    expect(sanitized).not.toBeNull();
    expect(sanitized.grid.root.type).toBe('branch');

    // All three panels survive in the single group.
    const leaf = (sanitized.grid.root.data as Node[])[0];
    const group = leaf.data as { views: string[] };
    expect(group.views).toEqual(['note:a', 'note:b', 'note:c']);
  });

  it('drops only panels whose note no longer exists', () => {
    const sanitized = sanitizeDockBlob(
      singleGroupBlob(['a', 'b', 'c']),
      resolveOnly(['a', 'c'])
    ) as { grid: { root: Node }; panels: Record<string, unknown> };

    expect(sanitized.grid.root.type).toBe('branch');
    const leaf = (sanitized.grid.root.data as Node[])[0];
    const group = leaf.data as { views: string[]; activeView: string };
    expect(group.views).toEqual(['note:a', 'note:c']);
    // activeView pointed at the pruned 'b' → reset to the first survivor.
    expect(group.activeView).toBe('note:a');
    expect(Object.keys(sanitized.panels)).toEqual(['note:a', 'note:c']);
  });

  it('returns null when every note is gone', () => {
    expect(
      sanitizeDockBlob(singleGroupBlob(['a', 'b']), resolveOnly([]))
    ).toBeNull();
  });

  it('refreshes component and title from the live note', () => {
    const resolve: ResolvePanel = () => ({
      component: 'pdfNote',
      title: 'Fresh'
    });
    const sanitized = sanitizeDockBlob(singleGroupBlob(['a']), resolve) as {
      panels: Record<string, { component: string; title: string }>;
    };
    expect(sanitized.panels['note:a'].component).toBe('pdfNote');
    expect(sanitized.panels['note:a'].title).toBe('Fresh');
  });

  it('keeps the root a branch after pruning one side of a split', () => {
    // root branch [ leafA, leafB ]; A's note is gone → branch keeps just B
    // as a single child (still a branch, never hoisted to a bare leaf).
    const blob = {
      grid: {
        root: {
          type: 'branch',
          data: [
            {
              type: 'leaf',
              data: { id: 'g1', views: ['note:a'], activeView: 'note:a' }
            },
            {
              type: 'leaf',
              data: { id: 'g2', views: ['note:b'], activeView: 'note:b' }
            }
          ]
        },
        width: 800,
        height: 600,
        orientation: 0
      },
      panels: { 'note:a': panel('a'), 'note:b': panel('b') }
    };

    const sanitized = sanitizeDockBlob(blob, resolveOnly(['b'])) as {
      grid: { root: Node };
    };
    expect(sanitized.grid.root.type).toBe('branch');
    const children = sanitized.grid.root.data as Node[];
    expect(children).toHaveLength(1);
    expect(children[0].type).toBe('leaf');
  });

  it('returns null for a malformed blob', () => {
    expect(sanitizeDockBlob(null, resolveAll)).toBeNull();
    expect(sanitizeDockBlob({ panels: [] }, resolveAll)).toBeNull();
  });
});
