import { describe, expect, it, vi } from 'vitest';

const { loadTree } = vi.hoisted(() => ({ loadTree: vi.fn() }));
vi.mock('./tree.svelte', () => ({ loadTree }));

import { refreshTree } from './tree-refresh';

describe('refreshTree', () => {
  it('delegates to the tree store loadTree', () => {
    loadTree.mockReturnValue(Promise.resolve());
    const result = refreshTree();
    expect(loadTree).toHaveBeenCalledOnce();
    expect(result).toBeInstanceOf(Promise);
  });
});
