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

  it('finds a longest common subsequence, as a full LCS table does', () => {
    // Small seeded inputs over a tiny alphabet, so lines repeat often.
    let seed = 7;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) | 0;
      return (seed >>> 16) % n;
    };
    const text = () =>
      Array.from({ length: random(12) }, () => 'abc'[random(3)]).join('\n');
    const lcsLength = (a: string[], b: string[]) => {
      const dp = Array.from({ length: a.length + 1 }, () =>
        new Array<number>(b.length + 1).fill(0)
      );
      for (let i = a.length - 1; i >= 0; i--)
        for (let j = b.length - 1; j >= 0; j--)
          dp[i][j] =
            a[i] === b[j]
              ? dp[i + 1][j + 1] + 1
              : Math.max(dp[i + 1][j], dp[i][j + 1]);
      return dp[0][0];
    };
    const lines = (s: string) => (s === '' ? [] : s.split('\n'));
    for (let run = 0; run < 2000; run++) {
      const before = text();
      const after = text();
      const ops = lineDiff(before, after);
      const old = ops.filter((o) => o.type !== 'add').map((o) => o.text);
      const now = ops.filter((o) => o.type !== 'del').map((o) => o.text);
      expect(old).toEqual(lines(before));
      expect(now).toEqual(lines(after));
      expect(ops.filter((o) => o.type === 'eq')).toHaveLength(
        lcsLength(lines(before), lines(after))
      );
    }
  });

  it('diffs a long note with a few scattered edits', () => {
    const before = Array.from({ length: 50_000 }, (_, i) => `line ${i}`);
    const after = before.map((line, i) =>
      i % 5_000 === 0 ? `${line} edited` : line
    );
    const ops = lineDiff(before.join('\n'), after.join('\n'));
    expect(diffStats(ops)).toEqual({ added: 10, removed: 10 });
    // A short note that grew long, and back.
    expect(diffStats(lineDiff('line 0\nline 1', before.join('\n')))).toEqual({
      added: 49_998,
      removed: 0
    });
    expect(diffStats(lineDiff(before.join('\n'), 'x\nline 9'))).toEqual({
      added: 1,
      removed: 49_999
    });
  });

  it('counts changed lines via diffStats', () => {
    const ops = lineDiff('a\nb\nc', 'a\nB\nc\nd');
    expect(diffStats(ops)).toEqual({ added: 2, removed: 1 });
  });
});
