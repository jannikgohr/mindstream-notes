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
  // Compare lines as numbers: one id per distinct line.
  const ids = new Map<string, number>();
  const id = (line: string) => {
    let n = ids.get(line);
    if (n === undefined) ids.set(line, (n = ids.size));
    return n;
  };
  const diff = new MyersDiff(Int32Array.from(a, id), Int32Array.from(b, id));
  diff.compare(0, a.length, 0, b.length);

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && diff.deleted[i]) {
      ops.push({ type: 'del', text: a[i++] });
    } else if (j < b.length && diff.added[j]) {
      ops.push({ type: 'add', text: b[j++] });
    } else {
      ops.push({ type: 'eq', text: a[i] });
      i++;
      j++;
    }
  }
  return ops;
}

/**
 * Myers' O(ND) diff in linear space: find the middle snake of the shortest
 * edit path, then solve each half. A full LCS table is quadratic in both
 * time and memory and runs out of heap on a long note.
 */
class MyersDiff {
  readonly deleted: Uint8Array;
  readonly added: Uint8Array;
  private readonly forward: Int32Array;
  private readonly backward: Int32Array;

  constructor(
    private readonly a: Int32Array,
    private readonly b: Int32Array
  ) {
    this.deleted = new Uint8Array(a.length);
    this.added = new Uint8Array(b.length);
    const size = a.length + b.length + 4;
    this.forward = new Int32Array(size);
    this.backward = new Int32Array(size);
  }

  compare(aLo: number, aHi: number, bLo: number, bHi: number): void {
    const { a, b } = this;
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
      aLo++;
      bLo++;
    }
    while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
      aHi--;
      bHi--;
    }
    if (aLo === aHi) {
      this.added.fill(1, bLo, bHi);
      return;
    }
    if (bLo === bHi) {
      this.deleted.fill(1, aLo, aHi);
      return;
    }
    const [x0, y0, x1, y1] = this.middleSnake(aLo, aHi, bLo, bHi);
    this.compare(aLo, aLo + x0, bLo, bLo + y0);
    this.compare(aLo + x1, aHi, bLo + y1, bHi);
  }

  /** The middle snake as [x0, y0, x1, y1], relative to (aLo, bLo). */
  private middleSnake(
    aLo: number,
    aHi: number,
    bLo: number,
    bHi: number
  ): [number, number, number, number] {
    const { a, b, forward: vf, backward: vb } = this;
    const n = aHi - aLo;
    const m = bHi - bLo;
    const delta = n - m;
    const odd = (delta & 1) === 1;
    const max = Math.ceil((n + m) / 2);
    const off = max + 1;
    // After d edits, diagonal k needs (d + k) / 2 deletions and (d - k) / 2
    // insertions, so a short side caps how many diagonals each step visits.
    const low = (d: number) => Math.max(-d, d - 2 * m);
    const high = (d: number) => Math.min(d, 2 * n - d);
    vf[off + 1] = 0;
    vb[off + 1] = 0;
    for (let d = 0; d <= max; d++) {
      for (let k = low(d); k <= high(d); k += 2) {
        let x =
          k === -d || (k !== d && vf[off + k - 1] < vf[off + k + 1])
            ? vf[off + k + 1]
            : vf[off + k - 1] + 1;
        let y = x - k;
        const x0 = x;
        const y0 = y;
        while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
          x++;
          y++;
        }
        vf[off + k] = x;
        const back = delta - k;
        if (odd && back >= low(d - 1) && back <= high(d - 1)) {
          if (x + vb[off + back] >= n) return [x0, y0, x, y];
        }
      }
      // The backward search runs on the reversed sequences.
      for (let k = low(d); k <= high(d); k += 2) {
        let x =
          k === -d || (k !== d && vb[off + k - 1] < vb[off + k + 1])
            ? vb[off + k + 1]
            : vb[off + k - 1] + 1;
        let y = x - k;
        const x0 = x;
        const y0 = y;
        while (x < n && y < m && a[aHi - 1 - x] === b[bHi - 1 - y]) {
          x++;
          y++;
        }
        vb[off + k] = x;
        const ahead = delta - k;
        if (!odd && ahead >= low(d) && ahead <= high(d)) {
          if (x + vf[off + ahead] >= n) return [n - x, m - y, n - x0, m - y0];
        }
      }
    }
    throw new Error('lineDiff: no middle snake');
  }
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
