import { beforeEach, describe, expect, it, vi } from 'vitest';

// markdown-actions is a thin Milkdown/ProseMirror command-dispatch table. We
// mock the editor primitives so each action's *delegation* is observable
// without a live editor (the commands themselves are e2e-covered).
const h = vi.hoisted(() => ({
  editorViewCtx: 'viewCtx',
  commandsCtx: 'commandsCtx',
  setBlockTypeCommand: { key: 'setBlockType' },
  schemaType: (name: string) => ({ type: vi.fn(() => `${name}Type`) }),
  toggleMark: vi.fn(() => vi.fn()),
  proseUndo: vi.fn(),
  proseRedo: vi.fn(),
  applyListAction: vi.fn(),
  insertImageBlock: vi.fn(),
  insertMath: vi.fn(),
  insertMermaid: vi.fn(),
  insertTable: vi.fn()
}));

vi.mock('@milkdown/kit/core', () => ({
  commandsCtx: h.commandsCtx,
  editorViewCtx: h.editorViewCtx
}));
vi.mock('@milkdown/kit/preset/commonmark', () => ({
  setBlockTypeCommand: h.setBlockTypeCommand,
  paragraphSchema: h.schemaType('paragraph'),
  headingSchema: h.schemaType('heading'),
  bulletListSchema: h.schemaType('bulletList'),
  orderedListSchema: h.schemaType('orderedList'),
  listItemSchema: h.schemaType('listItem'),
  codeBlockSchema: h.schemaType('codeBlock'),
  strongSchema: h.schemaType('strong'),
  emphasisSchema: h.schemaType('emphasis')
}));
vi.mock('@milkdown/kit/prose/commands', () => ({ toggleMark: h.toggleMark }));
vi.mock('@milkdown/kit/prose/history', () => ({
  undo: h.proseUndo,
  redo: h.proseRedo
}));
vi.mock('$lib/components/editor-toolbar/commands', () => ({
  applyListAction: h.applyListAction,
  insertImageBlock: h.insertImageBlock,
  insertMath: h.insertMath,
  insertMermaid: h.insertMermaid,
  insertTable: h.insertTable
}));

import { MARKDOWN_ACTIONS } from './markdown-actions';

const commandCall = vi.fn();

/** A fake Milkdown ctx whose selection sits inside `blockNames` (outermost→in). */
function makeCtx(blockNames: string[] = ['doc']) {
  const view = {
    state: {
      selection: {
        $from: {
          depth: blockNames.length - 1,
          node: (d: number) => ({ type: { name: blockNames[d] } })
        }
      }
    },
    dispatch: vi.fn(),
    focus: vi.fn()
  };
  return {
    get: (key: string) =>
      key === h.editorViewCtx ? view : { call: commandCall }
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MARKDOWN_ACTIONS', () => {
  it('every action runs without throwing on a plain paragraph selection', () => {
    const ctx = makeCtx(['doc', 'paragraph']);
    for (const action of Object.values(MARKDOWN_ACTIONS)) {
      expect(() => action(ctx)).not.toThrow();
    }
  });

  it('undo/redo delegate to the prose history commands', () => {
    MARKDOWN_ACTIONS['editor.markdown.undo'](makeCtx());
    expect(h.proseUndo).toHaveBeenCalled();
    MARKDOWN_ACTIONS['editor.markdown.redo'](makeCtx());
    expect(h.proseRedo).toHaveBeenCalled();
  });

  it('bold/italic apply a toggleMark command', () => {
    MARKDOWN_ACTIONS['editor.markdown.bold'](makeCtx());
    MARKDOWN_ACTIONS['editor.markdown.italic'](makeCtx());
    expect(h.toggleMark).toHaveBeenCalledTimes(2);
  });

  it('headings call setBlockTypeCommand with the level', () => {
    MARKDOWN_ACTIONS['editor.markdown.h2'](makeCtx(['doc', 'paragraph']));
    expect(commandCall).toHaveBeenCalledWith(
      'setBlockType',
      expect.objectContaining({ attrs: { level: 2 } })
    );
  });

  it('skips block conversions inside a code block or list', () => {
    MARKDOWN_ACTIONS['editor.markdown.h1'](makeCtx(['doc', 'code_block']));
    MARKDOWN_ACTIONS['editor.markdown.paragraph'](
      makeCtx(['doc', 'bullet_list', 'list_item'])
    );
    expect(commandCall).not.toHaveBeenCalled();
  });

  it('list toggles delegate to applyListAction; inserts delegate to their commands', () => {
    MARKDOWN_ACTIONS['editor.markdown.bulletList'](makeCtx());
    MARKDOWN_ACTIONS['editor.markdown.taskList'](makeCtx());
    expect(h.applyListAction).toHaveBeenCalledTimes(2);
    MARKDOWN_ACTIONS['editor.markdown.table'](makeCtx());
    MARKDOWN_ACTIONS['editor.markdown.math'](makeCtx());
    MARKDOWN_ACTIONS['editor.markdown.mermaidDiagram'](makeCtx());
    MARKDOWN_ACTIONS['editor.markdown.imageBlock'](makeCtx());
    expect(h.insertTable).toHaveBeenCalled();
    expect(h.insertMath).toHaveBeenCalled();
    expect(h.insertMermaid).toHaveBeenCalled();
    expect(h.insertImageBlock).toHaveBeenCalled();
  });

  it('code block conversion runs unconditionally via setBlockTypeCommand', () => {
    MARKDOWN_ACTIONS['editor.markdown.codeBlock'](makeCtx());
    expect(commandCall).toHaveBeenCalledWith(
      'setBlockType',
      expect.objectContaining({ nodeType: 'codeBlockType' })
    );
  });
});
