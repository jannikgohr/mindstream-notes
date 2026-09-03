/**
 * Milkdown `ctx`-wrapper coverage for the toolbar recipes.
 *
 * `commands.test.ts` exercises the pure transform (`applyListAction`) with
 * a real ProseMirror schema. This file covers the complementary half: the
 * thin `(ctx) => …` action/isActive callbacks that pull views, schema
 * types and the command bus out of a Milkdown `Ctx` and dispatch. The
 * Milkdown packages are mocked so each recipe can be invoked without a
 * live Crepe editor — we assert it dispatches the right command key with
 * the right node type, which is all these wrappers do.
 */

import { describe, expect, it, vi } from 'vitest';

// Stable sentinel node/mark types so assertions can compare by identity.
const mkType = (name: string) => ({ name, isInSet: () => null });
const PARAGRAPH = mkType('paragraph');
const HEADING = mkType('heading');
const BULLET_LIST = mkType('bullet_list');
const ORDERED_LIST = mkType('ordered_list');
const LIST_ITEM = mkType('list_item');
const CODE_BLOCK = mkType('code_block');
const STRONG = mkType('strong');
const EMPHASIS = mkType('emphasis');
const IMAGE_BLOCK = mkType('image_block');
const TABLE = mkType('table');

vi.mock('@milkdown/kit/core', () => ({
  commandsCtx: { slice: 'commands' },
  editorStateCtx: { slice: 'state' },
  editorViewCtx: { slice: 'view' }
}));
vi.mock('@milkdown/kit/preset/commonmark', () => ({
  setBlockTypeCommand: { key: 'setBlockType' },
  addBlockTypeCommand: { key: 'addBlockType' },
  paragraphSchema: { type: () => PARAGRAPH },
  headingSchema: { type: () => HEADING },
  bulletListSchema: { type: () => BULLET_LIST },
  orderedListSchema: { type: () => ORDERED_LIST },
  listItemSchema: { type: () => LIST_ITEM },
  codeBlockSchema: { type: () => CODE_BLOCK },
  strongSchema: { type: () => STRONG },
  emphasisSchema: { type: () => EMPHASIS },
  toggleStrongCommand: { key: 'toggleStrong' },
  toggleEmphasisCommand: { key: 'toggleEmphasis' }
}));
vi.mock('@milkdown/kit/preset/gfm', () => ({
  createTable: (_ctx: unknown, rows: number, cols: number) => ({
    ...TABLE,
    rows,
    cols
  })
}));
vi.mock('@milkdown/kit/component/image-block', () => ({
  imageBlockSchema: { type: () => IMAGE_BLOCK }
}));
vi.mock('@milkdown/kit/plugin/history', () => ({
  undoCommand: { key: 'undo' },
  redoCommand: { key: 'redo' }
}));

import { commandsCtx, editorStateCtx, editorViewCtx } from '@milkdown/kit/core';
import { TOOLBAR_ITEMS, type ToolbarLeaf } from './commands';

/** Find a toolbar leaf by id, descending into groups. */
function leaf(id: string): ToolbarLeaf {
  for (const item of TOOLBAR_ITEMS) {
    if (item.kind === 'leaf' && item.id === id) return item;
    if (item.kind === 'group') {
      const found = item.items.find((l) => l.id === id);
      if (found) return found;
    }
  }
  throw new Error(`no toolbar leaf "${id}"`);
}

/** A fake Milkdown Ctx whose `.get(key)` returns the wired dependency. */
function makeCtx({
  view,
  state
}: {
  view?: unknown;
  state?: unknown;
} = {}) {
  const call = vi.fn();
  const ctx = {
    get(key: unknown) {
      if (key === commandsCtx) return { call };
      if (key === editorViewCtx) return view;
      if (key === editorStateCtx) return state;
      throw new Error(`unexpected ctx key ${JSON.stringify(key)}`);
    }
  } as any;
  return { ctx, call };
}

/** A caret sitting in a plain paragraph (not inside code or a list). */
const paragraphView = {
  state: {
    selection: {
      $from: {
        depth: 1,
        node: (d: number) => ({ type: { name: d === 0 ? 'doc' : 'paragraph' } })
      }
    }
  },
  dispatch: vi.fn()
};

/** A caret sitting inside a code block. */
const codeBlockView = {
  state: {
    selection: {
      $from: {
        depth: 1,
        node: (d: number) => ({
          type: { name: d === 0 ? 'doc' : 'code_block' }
        })
      }
    }
  },
  dispatch: vi.fn()
};

/** An empty selection whose block spans no list lines, so `applyListAction`
 *  bails at its `blocks.length === 0` guard without needing a real doc. */
const emptyListView = {
  state: {
    selection: { from: 0, to: 0, empty: true },
    doc: { nodesBetween: () => {} }
  },
  dispatch: vi.fn()
};

describe('history + inline-mark recipes', () => {
  it('undo / redo dispatch the history command keys', () => {
    for (const [id, key] of [
      ['undo', 'undo'],
      ['redo', 'redo']
    ] as const) {
      const { ctx, call } = makeCtx();
      leaf(id).action(ctx);
      expect(call).toHaveBeenCalledWith(key);
    }
  });

  it('bold / italic dispatch the toggle command keys', () => {
    for (const [id, key] of [
      ['bold', 'toggleStrong'],
      ['italic', 'toggleEmphasis']
    ] as const) {
      const { ctx, call } = makeCtx();
      leaf(id).action(ctx);
      expect(call).toHaveBeenCalledWith(key);
    }
  });

  it('isActive reads the mark state for an empty selection', () => {
    const state = {
      selection: { empty: true, from: 0, to: 0, $from: { marks: () => [] } },
      storedMarks: null
    };
    const { ctx } = makeCtx({ state });
    expect(leaf('bold').isActive?.(ctx)).toBe(false);
    expect(leaf('italic').isActive?.(ctx)).toBe(false);
  });

  it('isActive reports true when a non-empty selection carries the mark', () => {
    const state = {
      selection: { empty: false, from: 0, to: 4, $from: { marks: () => [] } },
      doc: { rangeHasMark: () => true }
    };
    const { ctx } = makeCtx({ state });
    expect(leaf('bold').isActive?.(ctx)).toBe(true);
  });
});

describe('text-style recipes', () => {
  it('paragraph swaps the block type outside code/lists', () => {
    const { ctx, call } = makeCtx({ view: paragraphView });
    leaf('p').action(ctx);
    expect(call).toHaveBeenCalledWith('setBlockType', { nodeType: PARAGRAPH });
  });

  it('paragraph is a no-op inside a code block', () => {
    const { ctx, call } = makeCtx({ view: codeBlockView });
    leaf('p').action(ctx);
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    ['h1', 1],
    ['h2', 2],
    ['h3', 3],
    ['h4', 4],
    ['h5', 5],
    ['h6', 6]
  ])('%s sets a heading of the matching level', (id, level) => {
    const { ctx, call } = makeCtx({ view: paragraphView });
    leaf(id).action(ctx);
    expect(call).toHaveBeenCalledWith('setBlockType', {
      nodeType: HEADING,
      attrs: { level }
    });
  });

  it('headings are skipped inside a code block', () => {
    const { ctx, call } = makeCtx({ view: codeBlockView });
    leaf('h1').action(ctx);
    expect(call).not.toHaveBeenCalled();
  });
});

describe('list recipes', () => {
  it.each(['ordered', 'bullet', 'task'])(
    '%s pulls schema types from ctx and runs the transform',
    (id) => {
      const { ctx } = makeCtx({ view: emptyListView });
      // The empty selection means the transform bails cleanly; we're
      // covering the ctx-unpacking wrapper, not the transform itself.
      expect(() => leaf(id).action(ctx)).not.toThrow();
      expect(emptyListView.dispatch).not.toHaveBeenCalled();
    }
  );
});

describe('advanced insert recipes', () => {
  it('image / code insert a fresh block after the line', () => {
    const image = makeCtx();
    leaf('image').action(image.ctx);
    expect(image.call).toHaveBeenCalledWith('addBlockType', {
      nodeType: IMAGE_BLOCK
    });

    const code = makeCtx();
    leaf('code').action(code.ctx);
    expect(code.call).toHaveBeenCalledWith('addBlockType', {
      nodeType: CODE_BLOCK
    });
  });

  it('table inserts a 3×3 grid', () => {
    const { ctx, call } = makeCtx();
    leaf('table').action(ctx);
    expect(call).toHaveBeenCalledWith('addBlockType', {
      nodeType: { ...TABLE, rows: 3, cols: 3 }
    });
  });

  it('math / mermaid insert a language-tagged code block', () => {
    const math = makeCtx();
    leaf('math').action(math.ctx);
    expect(math.call).toHaveBeenCalledWith('addBlockType', {
      nodeType: CODE_BLOCK,
      attrs: { language: 'LaTeX' }
    });

    const mermaid = makeCtx();
    leaf('mermaid').action(mermaid.ctx);
    expect(mermaid.call).toHaveBeenCalledWith('addBlockType', {
      nodeType: CODE_BLOCK,
      attrs: { language: 'mermaid' }
    });
  });
});
