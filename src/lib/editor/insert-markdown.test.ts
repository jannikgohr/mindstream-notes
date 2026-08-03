import { beforeEach, describe, expect, it, vi } from 'vitest';

const getDoc = vi.hoisted(() => vi.fn());
vi.mock('@milkdown/kit/core', () => ({
  editorViewCtx: 'viewCtx',
  parserCtx: 'parserCtx',
  schemaCtx: 'schemaCtx',
  getDoc
}));

import { insertMarkdownAtSelection } from './insert-markdown';
import type { Ctx } from '@milkdown/kit/ctx';

function harness() {
  const dispatch = vi.fn();
  const focus = vi.fn();
  const replaceSelection = vi.fn(() => 'TR');
  const view = {
    state: { tr: { replaceSelection } },
    dispatch,
    focus
  };
  const ctx = {
    get: (key: string) =>
      key === 'viewCtx' ? view : key === 'parserCtx' ? 'parser' : 'schema'
  } as unknown as Ctx;
  return { ctx, dispatch, focus, replaceSelection };
}

beforeEach(() => getDoc.mockReset());

describe('insertMarkdownAtSelection', () => {
  it('replaces the selection with the parsed slice and refocuses', () => {
    const slice = vi.fn(() => ({}));
    getDoc.mockReturnValue({ content: { size: 5 }, slice });
    const { ctx, dispatch, focus, replaceSelection } = harness();

    insertMarkdownAtSelection(ctx, '# Hello');

    expect(getDoc).toHaveBeenCalledWith('# Hello', 'parser', 'schema');
    expect(slice).toHaveBeenCalledWith(0);
    expect(replaceSelection).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith('TR');
    expect(focus).toHaveBeenCalled();
  });

  it('is a no-op when the markdown parses to nothing', () => {
    const { ctx, dispatch, focus } = harness();
    getDoc.mockReturnValue(null);
    insertMarkdownAtSelection(ctx, '');
    expect(dispatch).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it('is a no-op when the parsed node is empty', () => {
    const { ctx, dispatch } = harness();
    getDoc.mockReturnValue({ content: { size: 0 }, slice: vi.fn() });
    insertMarkdownAtSelection(ctx, '   ');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
