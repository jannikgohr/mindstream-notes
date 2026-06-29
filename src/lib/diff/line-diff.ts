/**
 * Minimal line-level diff (LCS) for rendering a read-only "old vs current"
 * view of a note version. Returns ops in document order; equal lines are
 * kept so the diff reads as context, not just a changelog.
 *
 * Line-level (not word/char) is deliberate: it's cheap, stable, and matches
 * how markdown reads. No external dependency.
 */

export type DiffOpType = 'add' | 'del' | 'eq';

export interface DiffOp {
  type: DiffOpType;
  text: string;
}

function toLines(s: string): string[] {
  return s === '' ? [] : s.split('\n');
}

export function lineDiff(oldText: string, newText: string): DiffOp[] {
  const a = toLines(oldText);
  const b = toLines(newText);
  const m = a.length;
  const n = b.length;

  // LCS length table, filled bottom-up.
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0)
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ type: 'eq', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', text: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < m) ops.push({ type: 'del', text: a[i++] });
  while (j < n) ops.push({ type: 'add', text: b[j++] });
  return ops;
}

/** Count changed lines, for a compact summary above a diff. */
export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added++;
    else if (op.type === 'del') removed++;
  }
  return { added, removed };
}
