/**
 * Steps 5-7: mask → polylines.
 *
 * Zhang-Suen thinning erodes the mask to a 1-pixel skeleton preserving
 * connectivity, the skeleton walk turns it into pen movements (following
 * direction through junctions so a self-crossing stroke stays one
 * stroke), and Douglas-Peucker drops the points that don't carry shape.
 */

import type { PdfStrokePoint } from '../types';
import { NEIGHBOURS, type BinaryMask } from './types';

/**
 * Iteratively erode the ink mask down to a 1-pixel-wide skeleton while
 * preserving connectivity (Zhang-Suen, 1984). Out-of-bounds neighbours
 * read as background.
 */
export function thin(mask: BinaryMask): BinaryMask {
  const { width, height } = mask;
  const data = Uint8Array.from(mask.data);
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : data[y * width + x];

  const toClear: number[] = [];
  // Each pass peels at most one pixel of thickness from each side, so
  // the stroke half-width bounds the iteration count; the cap is a
  // safety net, not a tuning knob.
  const maxIterations = Math.max(width, height);

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    for (let sub = 0; sub < 2; sub++) {
      toClear.length = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (!data[y * width + x]) continue;
          // Neighbours clockwise from north: P2..P9.
          const p2 = at(x, y - 1);
          const p3 = at(x + 1, y - 1);
          const p4 = at(x + 1, y);
          const p5 = at(x + 1, y + 1);
          const p6 = at(x, y + 1);
          const p7 = at(x - 1, y + 1);
          const p8 = at(x - 1, y);
          const p9 = at(x - 1, y - 1);
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let transitions = 0;
          for (let i = 0; i < 8; i++) {
            if (seq[i] === 0 && seq[i + 1] === 1) transitions += 1;
          }
          if (transitions !== 1) continue;
          if (sub === 0) {
            if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
          }
          toClear.push(y * width + x);
        }
      }
      for (const idx of toClear) data[idx] = 0;
      if (toClear.length > 0) changed = true;
    }
    if (!changed) break;
  }
  return { width, height, data };
}

/* --- Step 6: skeleton → polylines ---------------------------------------------- */

/**
 * Walk the 1-px skeleton into polylines. Walks start at endpoints
 * (single-neighbour pixels) and continue as long as an unvisited
 * neighbour exists, preferring the neighbour that best continues the
 * current direction — so a stroke that crosses itself is traced as one
 * long pen movement instead of being chopped at the junction. Closed
 * loops (no endpoints, e.g. an "o") are picked up in a second pass.
 */
export function traceSkeleton(mask: BinaryMask): PdfStrokePoint[][] {
  const { width, height, data } = mask;
  const visited = new Uint8Array(data.length);

  const neighboursOf = (idx: number): number[] => {
    const x = idx % width;
    const y = (idx - x) / width;
    const out: number[] = [];
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (data[nIdx]) out.push(nIdx);
    }
    return out;
  };

  const walk = (start: number): PdfStrokePoint[] => {
    const path: number[] = [start];
    visited[start] = 1;
    let prev = -1;
    let current = start;
    for (;;) {
      const candidates = neighboursOf(current).filter((idx) => !visited[idx]);
      if (candidates.length === 0) break;
      let next = candidates[0];
      if (prev !== -1 && candidates.length > 1) {
        // Prefer the straightest continuation (largest cosine between
        // the incoming and outgoing step vectors).
        const cx = current % width;
        const cy = (current - cx) / width;
        const px = prev % width;
        const py = (prev - px) / width;
        const inX = cx - px;
        const inY = cy - py;
        let bestDot = -Infinity;
        for (const cand of candidates) {
          const nx = cand % width;
          const ny = (cand - nx) / width;
          const outX = nx - cx;
          const outY = ny - cy;
          const dot =
            (inX * outX + inY * outY) /
            (Math.hypot(inX, inY) * Math.hypot(outX, outY));
          if (dot > bestDot) {
            bestDot = dot;
            next = cand;
          }
        }
      }
      path.push(next);
      visited[next] = 1;
      prev = current;
      current = next;
    }
    return path.map((idx) => {
      const x = idx % width;
      return { x, y: (idx - x) / width };
    });
  };

  const polylines: PdfStrokePoint[][] = [];

  // Pass 1: open strokes, walked from their endpoints.
  for (let idx = 0; idx < data.length; idx++) {
    if (!data[idx] || visited[idx]) continue;
    if (neighboursOf(idx).length !== 1) continue;
    polylines.push(walk(idx));
  }

  // Pass 2: whatever remains is loops (or junction leftovers). Isolated
  // single pixels are dropped — after despeckling they're noise.
  for (let idx = 0; idx < data.length; idx++) {
    if (!data[idx] || visited[idx]) continue;
    if (neighboursOf(idx).length === 0) {
      visited[idx] = 1;
      continue;
    }
    const loop = walk(idx);
    // Close the ring visually when the walk ended adjacent to its start.
    if (loop.length > 2) {
      const first = loop[0];
      const last = loop[loop.length - 1];
      if (Math.abs(first.x - last.x) <= 1 && Math.abs(first.y - last.y) <= 1) {
        loop.push({ ...first });
      }
    }
    polylines.push(loop);
  }

  return polylines.filter((line) => line.length >= 2);
}

/* --- Step 7: simplification ----------------------------------------------------- */

/** Iterative Ramer-Douglas-Peucker. Keeps endpoints, drops points whose
 *  perpendicular distance to the chord is within `tolerance`. */
export function simplifyPolyline(
  points: PdfStrokePoint[],
  tolerance: number
): PdfStrokePoint[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop()!;
    const a = points[from];
    const b = points[to];
    const abX = b.x - a.x;
    const abY = b.y - a.y;
    const abLen = Math.hypot(abX, abY);
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = from + 1; i < to; i++) {
      const p = points[i];
      const dist =
        abLen === 0
          ? Math.hypot(p.x - a.x, p.y - a.y)
          : Math.abs(abX * (a.y - p.y) - (a.x - p.x) * abY) / abLen;
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }
    if (maxDist > tolerance && maxIdx !== -1) {
      keep[maxIdx] = 1;
      stack.push([from, maxIdx], [maxIdx, to]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}
