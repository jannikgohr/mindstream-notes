import { describe, expect, it } from 'vitest';
import {
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
