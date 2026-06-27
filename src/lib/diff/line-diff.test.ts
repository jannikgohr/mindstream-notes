import { describe, expect, it } from 'vitest';
import { diffStats, lineDiff } from './line-diff';

describe('lineDiff', () => {
  it('marks all-equal text as context only', () => {
    const ops = lineDiff('a\nb\nc', 'a\nb\nc');
    expect(ops.every((o) => o.type === 'eq')).toBe(true);
    expect(ops.map((o) => o.text)).toEqual(['a', 'b', 'c']);
  });

  it('detects a changed middle line as del + add around shared context', () => {
    const ops = lineDiff('a\nb\nc', 'a\nB\nc');
    expect(ops).toEqual([
      { type: 'eq', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'eq', text: 'c' }
    ]);
  });

  it('handles pure insertion and deletion against empty', () => {
    expect(lineDiff('', 'x\ny')).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' }
    ]);
    expect(lineDiff('x\ny', '')).toEqual([
      { type: 'del', text: 'x' },
      { type: 'del', text: 'y' }
    ]);
  });

  it('keeps shared lines when appending', () => {
    const ops = lineDiff('one\ntwo', 'one\ntwo\nthree');
    expect(ops).toEqual([
      { type: 'eq', text: 'one' },
      { type: 'eq', text: 'two' },
      { type: 'add', text: 'three' }
    ]);
  });

  it('counts changed lines via diffStats', () => {
    const ops = lineDiff('a\nb\nc', 'a\nB\nc\nd');
    expect(diffStats(ops)).toEqual({ added: 2, removed: 1 });
  });
});
