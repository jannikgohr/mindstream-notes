import { describe, expect, it, vi } from 'vitest';
import {
  insertMarkdownIntoActiveNote,
  registerEditor,
  type EditorListener
} from './bus.svelte';

/** A minimal listener; `host` is never touched on the insert path so a stub
 *  element is fine. */
function listener(over: Partial<EditorListener>): EditorListener {
  return {
    kind: 'markdown',
    host: {} as unknown as HTMLElement,
    onCommand: () => false,
    ...over
  };
}

describe('insertMarkdownIntoActiveNote', () => {
  it('no-ops (returns false) when no editor is registered', () => {
    expect(insertMarkdownIntoActiveNote('# hi')).toBe(false);
  });

  it('routes markdown to the active editor and reports success', () => {
    const insertMarkdown = vi.fn(() => true);
    const unregister = registerEditor(
      listener({ noteId: 'n1', insertMarkdown })
    );
    expect(insertMarkdownIntoActiveNote('# hi')).toBe(true);
    expect(insertMarkdown).toHaveBeenCalledWith('# hi');
    unregister();
  });

  it('only targets the editor for the given note id', () => {
    const insertMarkdown = vi.fn(() => true);
    const unregister = registerEditor(
      listener({ noteId: 'n1', insertMarkdown })
    );
    expect(insertMarkdownIntoActiveNote('x', 'n1')).toBe(true);
    insertMarkdown.mockClear();
    expect(insertMarkdownIntoActiveNote('x', 'other')).toBe(false);
    expect(insertMarkdown).not.toHaveBeenCalled();
    unregister();
  });

  it('returns false when the active editor cannot insert markdown', () => {
    const unregister = registerEditor(listener({ kind: 'ink', noteId: 'n2' }));
    expect(insertMarkdownIntoActiveNote('x')).toBe(false);
    unregister();
  });
});
