import { describe, expect, it } from 'vitest';
import type { NoteSummary, TreeNode } from '$lib/api';
import { filterNodesByTags, tagFilterOptions } from './tag-filter.svelte';

const note = (id: string): TreeNode => ({
  kind: 'note',
  id,
  name: id,
  position: 0,
  parent_collection_id: null
});
const folder = (id: string, children: TreeNode[]): TreeNode => ({
  kind: 'folder',
  id,
  name: id,
  position: 0,
  parent_collection_id: null,
  children
});
const notes = (tags: Record<string, string[]>) =>
  Object.fromEntries(
    Object.entries(tags).map(([id, t]) => [id, { id, tags: t }])
  ) as unknown as Record<string, NoteSummary>;

describe('filterNodesByTags', () => {
  const byId = notes({
    a: ['work/urgent', 'home'],
    b: ['work'],
    c: ['workshop'],
    d: []
  });
  const tree = [
    folder('f1', [note('a'), folder('empty', [note('d')])]),
    folder('f2', [note('c')]),
    note('b')
  ];
  const ids = (nodes: TreeNode[]): unknown[] =>
    nodes.map((n) =>
      n.kind === 'folder' ? { [n.id]: ids(n.children) } : n.id
    );

  it('matches a parent tag against its nested tags, not a shared prefix', () => {
    expect(ids(filterNodesByTags(tree, byId, ['work']))).toEqual([
      { f1: ['a'] },
      'b'
    ]);
  });

  it('requires every selected tag', () => {
    expect(ids(filterNodesByTags(tree, byId, ['work', 'home']))).toEqual([
      { f1: ['a'] }
    ]);
  });

  it('returns the tree untouched without a filter', () => {
    expect(filterNodesByTags(tree, byId, [])).toBe(tree);
  });
});

describe('tagFilterOptions', () => {
  it('adds parent paths and keeps children under their parent', () => {
    expect(
      tagFilterOptions(['work-log', 'work/urgent', 'home']).map((o) => [
        o.path,
        o.depth
      ])
    ).toEqual([
      ['home', 0],
      ['work', 0],
      ['work/urgent', 1],
      ['work-log', 0]
    ]);
  });
});
