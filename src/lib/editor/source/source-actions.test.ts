import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { history } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { APP_REDO_COMMAND, APP_UNDO_COMMAND } from '$lib/hotkeys/bus.svelte';
import {
  SOURCE_ACTIONS,
  applyHeading,
  insertBlock,
  toggleInlineMarker,
  toggleListPrefix,
  type SourceEdit
} from './source-actions';

/** Apply a SourceEdit's changes to a string (rightmost first so earlier
 *  positions stay valid), returning the resulting document. */
function apply(doc: string, edit: SourceEdit): string {
  const sorted = [...edit.changes].sort((a, b) => b.from - a.from);
  let out = doc;
  for (const c of sorted)
    out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

describe('toggleInlineMarker', () => {
  it('wraps a selection', () => {
    const doc = 'hello world';
    const edit = toggleInlineMarker(doc, 0, 5, '**');
    expect(apply(doc, edit)).toBe('**hello** world');
    // Selection stays over the word, now shifted past the opening marker.
    expect(edit.selection).toEqual({ anchor: 2, head: 7 });
  });

  it('inserts an empty pair and drops the caret between the markers', () => {
    const doc = 'ab';
    const edit = toggleInlineMarker(doc, 1, 1, '**');
    expect(apply(doc, edit)).toBe('a****b');
    expect(edit.selection).toEqual({ anchor: 3, head: 3 });
  });

  it('unwraps when markers sit just outside the selection', () => {
    const doc = '**hello** world';
    // selection is "hello" (between the markers)
    const edit = toggleInlineMarker(doc, 2, 7, '**');
    expect(apply(doc, edit)).toBe('hello world');
  });

  it('unwraps when markers are inside the selection', () => {
    const doc = '**hello** world';
    // selection includes the markers
    const edit = toggleInlineMarker(doc, 0, 9, '**');
    expect(apply(doc, edit)).toBe('hello world');
  });

  it('handles italic (single-char marker)', () => {
    const doc = 'word';
    expect(apply(doc, toggleInlineMarker(doc, 0, 4, '*'))).toBe('*word*');
  });
});

describe('applyHeading', () => {
  it('prefixes a line', () => {
    const doc = 'Title';
    expect(apply(doc, applyHeading(doc, 0, 0, 1))).toBe('# Title');
    expect(apply(doc, applyHeading(doc, 0, 0, 3))).toBe('### Title');
  });

  it('replaces an existing heading rather than stacking', () => {
    const doc = '## Title';
    expect(apply(doc, applyHeading(doc, 0, 0, 1))).toBe('# Title');
  });

  it('strips back to a paragraph at level 0', () => {
    const doc = '### Title';
    expect(apply(doc, applyHeading(doc, 0, 0, 0))).toBe('Title');
  });

  it('converts a list item into a heading', () => {
    const doc = '- Title';
    expect(apply(doc, applyHeading(doc, 0, 0, 2))).toBe('## Title');
  });

  it('applies to every line in a multi-line selection', () => {
    const doc = 'One\nTwo';
    expect(apply(doc, applyHeading(doc, 0, doc.length, 1))).toBe(
      '# One\n# Two'
    );
  });

  it('preserves leading indentation', () => {
    const doc = '  Nested';
    expect(apply(doc, applyHeading(doc, 0, 0, 1))).toBe('  # Nested');
  });
});

describe('toggleListPrefix', () => {
  it('adds a bullet prefix', () => {
    const doc = 'item';
    expect(apply(doc, toggleListPrefix(doc, 0, 0, 'bullet'))).toBe('- item');
  });

  it('toggles a bullet off when every line already has it', () => {
    const doc = '- a\n- b';
    expect(apply(doc, toggleListPrefix(doc, 0, doc.length, 'bullet'))).toBe(
      'a\nb'
    );
  });

  it('numbers an ordered list sequentially', () => {
    const doc = 'a\nb\nc';
    expect(apply(doc, toggleListPrefix(doc, 0, doc.length, 'ordered'))).toBe(
      '1. a\n2. b\n3. c'
    );
  });

  it('adds task-list checkboxes', () => {
    const doc = 'todo';
    expect(apply(doc, toggleListPrefix(doc, 0, 0, 'task'))).toBe('- [ ] todo');
  });

  it('unifies a mixed selection to the target kind', () => {
    const doc = '- a\nb';
    // Not every line is a bullet → both become bullets.
    expect(apply(doc, toggleListPrefix(doc, 0, doc.length, 'bullet'))).toBe(
      '- a\n- b'
    );
  });

  it('switches an existing bullet to a task item', () => {
    const doc = '- a';
    expect(apply(doc, toggleListPrefix(doc, 0, doc.length, 'task'))).toBe(
      '- [ ] a'
    );
  });
});

describe('insertBlock', () => {
  it('drops the snippet onto the current line when it is blank', () => {
    const doc = '';
    const edit = insertBlock(doc, 0, 0, '```\n\n```', 4);
    expect(apply(doc, edit)).toBe('```\n\n```');
    // caretOffset 4 → just after the opening fence + newline
    expect(edit.selection).toEqual({ anchor: 4, head: 4 });
  });

  it('opens a fresh line below a non-empty line', () => {
    const doc = 'text';
    const edit = insertBlock(doc, 4, 4, '$$\n\n$$', 3);
    expect(apply(doc, edit)).toBe('text\n$$\n\n$$');
    // insertPos 4 (line end) + lead '\n' (1) + caretOffset 3 = 8
    expect(edit.selection).toEqual({ anchor: 8, head: 8 });
  });
});

/* --- SOURCE_ACTIONS driving a live CodeMirror view ------------------------ */

/**
 * The `SOURCE_ACTIONS` glue applies the pure transforms above to a real
 * `EditorView` (and defers undo/redo to CodeMirror's history). These drive the
 * actual map so the thin dispatch layer — not just the string transforms — is
 * exercised end to end.
 */
function view(doc: string, anchor = 0, head = anchor): EditorView {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: EditorSelection.range(anchor, head),
      extensions: [history()]
    })
  });
}

function run(v: EditorView, command: string) {
  const action = SOURCE_ACTIONS[command];
  if (!action) throw new Error(`no source action for ${command}`);
  action(v);
}

describe('SOURCE_ACTIONS', () => {
  it('bold wraps the selection', () => {
    const v = view('hello world', 0, 5);
    run(v, 'editor.markdown.bold');
    expect(v.state.doc.toString()).toBe('**hello** world');
    v.destroy();
  });

  it('italic wraps the selection', () => {
    const v = view('word', 0, 4);
    run(v, 'editor.markdown.italic');
    expect(v.state.doc.toString()).toBe('*word*');
    v.destroy();
  });

  it('h2 prefixes the caret line', () => {
    const v = view('Title', 0);
    run(v, 'editor.markdown.h2');
    expect(v.state.doc.toString()).toBe('## Title');
    v.destroy();
  });

  it('paragraph strips an existing heading', () => {
    const v = view('### Title', 0);
    run(v, 'editor.markdown.paragraph');
    expect(v.state.doc.toString()).toBe('Title');
    v.destroy();
  });

  it('bulletList adds a bullet prefix', () => {
    const v = view('item', 0);
    run(v, 'editor.markdown.bulletList');
    expect(v.state.doc.toString()).toBe('- item');
    v.destroy();
  });

  it('taskList adds a checkbox prefix', () => {
    const v = view('todo', 0);
    run(v, 'editor.markdown.taskList');
    expect(v.state.doc.toString()).toBe('- [ ] todo');
    v.destroy();
  });

  it('codeBlock inserts the fence and drops the caret inside', () => {
    const v = view('', 0);
    run(v, 'editor.markdown.codeBlock');
    expect(v.state.doc.toString()).toBe('```\n\n```');
    // Caret lands on the empty middle line (offset 4: after "```\n").
    expect(v.state.selection.main.head).toBe(4);
    v.destroy();
  });

  it('imageBlock inserts the snippet with the caret in the alt text', () => {
    const v = view('', 0);
    run(v, 'editor.markdown.imageBlock');
    expect(v.state.doc.toString()).toBe('![]()');
    expect(v.state.selection.main.head).toBe(2); // between the brackets
    v.destroy();
  });

  it('undo/redo defer to CodeMirror history (via the app-level commands)', () => {
    const v = view('start', 5);
    run(v, 'editor.markdown.bold'); // some undoable change
    expect(v.state.doc.toString()).not.toBe('start');

    run(v, APP_UNDO_COMMAND);
    expect(v.state.doc.toString()).toBe('start');

    run(v, APP_REDO_COMMAND);
    expect(v.state.doc.toString()).not.toBe('start');
    v.destroy();
  });

  it('exposes both the app-level and editor.markdown undo/redo ids', () => {
    // All four keys resolve to a callable — the table mirrors MARKDOWN_ACTIONS.
    for (const id of [
      APP_UNDO_COMMAND,
      APP_REDO_COMMAND,
      'editor.markdown.undo',
      'editor.markdown.redo'
    ]) {
      expect(typeof SOURCE_ACTIONS[id]).toBe('function');
    }
  });
});
