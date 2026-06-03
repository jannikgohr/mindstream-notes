import { describe, expect, it } from 'vitest';
import { sortTree } from './sort';
import type { NoteSummary, TreeNode } from './api';

const note = (
  id: string,
  title: string,
  modified = '2024-01-01T00:00:00Z'
): NoteSummary => ({
  id,
  parent_collection_id: null,
  title,
  position: 0,
  created: modified,
  modified,
  tags: [],
  trashed: false,
  favourite: false,
  pushed: false,
  note_kind: 'markdown'
});

const folder = (
  id: string,
  name: string,
  children: TreeNode[] = []
): TreeNode => ({
  kind: 'folder',
  id,
  name,
  position: 0,
  parent_collection_id: null,
  children
});

const noteNode = (id: string, name: string): TreeNode => ({
  kind: 'note',
  id,
  name,
  position: 0,
  parent_collection_id: null
});

describe('sortTree', () => {
  it('puts folders before notes regardless of strategy', () => {
    const tree: TreeNode[] = [
      noteNode('n1', 'banana'),
      folder('f1', 'zeta'),
      noteNode('n2', 'apple'),
      folder('f2', 'alpha')
    ];
    const out = sortTree(tree, 'alphabetical', { notesById: {} });
    expect(out.map((n) => n.kind)).toEqual([
      'folder',
      'folder',
      'note',
      'note'
    ]);
  });

  it('alphabetical: case-insensitive, name order', () => {
    const tree: TreeNode[] = [
      noteNode('n1', 'banana'),
      noteNode('n2', 'Apple'),
      noteNode('n3', 'cherry')
    ];
    const out = sortTree(tree, 'alphabetical', { notesById: {} });
    expect(out.map((n) => n.name)).toEqual(['Apple', 'banana', 'cherry']);
  });

  it('modified asc: oldest first by note timestamp', () => {
    const ctx = {
      notesById: {
        n1: note('n1', 'old', '2020-01-01T00:00:00Z'),
        n2: note('n2', 'new', '2024-06-01T00:00:00Z'),
        n3: note('n3', 'mid', '2022-03-15T00:00:00Z')
      }
    };
    const tree: TreeNode[] = [
      noteNode('n1', 'old'),
      noteNode('n2', 'new'),
      noteNode('n3', 'mid')
    ];
    const out = sortTree(tree, 'modified', ctx, 'asc');
    expect(out.map((n) => n.id)).toEqual(['n1', 'n3', 'n2']);
  });

  it('modified desc: newest first by note timestamp', () => {
    const ctx = {
      notesById: {
        n1: note('n1', 'old', '2020-01-01T00:00:00Z'),
        n2: note('n2', 'new', '2024-06-01T00:00:00Z'),
        n3: note('n3', 'mid', '2022-03-15T00:00:00Z')
      }
    };
    const tree: TreeNode[] = [
      noteNode('n1', 'old'),
      noteNode('n2', 'new'),
      noteNode('n3', 'mid')
    ];
    const out = sortTree(tree, 'modified', ctx, 'desc');
    expect(out.map((n) => n.id)).toEqual(['n2', 'n3', 'n1']);
  });

  it('alphabetical desc: reverses A→Z to Z→A', () => {
    const tree: TreeNode[] = [
      noteNode('n1', 'banana'),
      noteNode('n2', 'Apple'),
      noteNode('n3', 'cherry')
    ];
    const out = sortTree(tree, 'alphabetical', { notesById: {} }, 'desc');
    expect(out.map((n) => n.name)).toEqual(['cherry', 'banana', 'Apple']);
  });

  it('recurses into folder children with the same strategy', () => {
    const tree: TreeNode[] = [
      folder('f1', 'work', [noteNode('a', 'b'), noteNode('b', 'a')])
    ];
    const out = sortTree(tree, 'alphabetical', { notesById: {} });
    const f = out[0] as TreeNode & { children: TreeNode[] };
    expect((f as { children: TreeNode[] }).children.map((n) => n.name)).toEqual(
      ['a', 'b']
    );
  });
});
