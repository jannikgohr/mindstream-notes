/**
 * The force layout behind a schema view's `graph`: links pull, nodes repel,
 * everything is drawn to the origin, and nodes don't overlap. The forces are
 * d3-force's. It is written over typed arrays because d3's object per node and
 * per link costs several times as much on a graph of tens of thousands.
 */

const VELOCITY_KEEP = 0.6;
const ALPHA_MIN = 0.001;
const COLLIDE_PAD = 2;
// Deeper than this, nodes share a leaf: they are as good as in one place.
const MAX_DEPTH = 24;

export interface ForceOptions {
  /** Per node. */
  radius: Float32Array;
  /** Starting positions; NaN lets the layout place the node. */
  x: Float32Array;
  y: Float32Array;
  /**
   * Index pairs. For `active` to hide links, they are ordered by the higher
   * of their two ends.
   */
  links: Uint32Array;
  alpha: number;
  /** How fast the layout cools, per tick. */
  alphaDecay: number;
  /** Repulsion reaches no further than this. */
  chargeReach: number;
  /**
   * How coarsely far nodes are grouped when they repel: 0.9 is d3's. Higher
   * is faster and a little less even.
   */
  theta: number;
  collide: boolean;
  /** How hard nodes are drawn to the origin: 0.04 is the usual. */
  centre: number;
  /** How hard nodes push each other apart: 60 is the usual. */
  repel: number;
  /** The length a link rests at: 40 is the usual. */
  linkDistance: number;
  /**
   * Scales every link's pull. Below 1 suits a graph with so many links that
   * they would otherwise crush it into a lopsided clump.
   */
  linkStrength: number;
}

export interface ForceLayout {
  readonly x: Float64Array;
  readonly y: Float64Array;
  alpha: number;
  /** What `alpha` cools to: above 0 keeps the layout moving, as in a drag. */
  alphaTarget: number;
  /**
   * Repulsion is worked out for one node in this many each tick, in turn,
   * and the rest keep the push they last had. It is most of a tick's cost,
   * and a node's push changes little from one tick to the next.
   */
  chargeEvery: number;
  /**
   * Only the first this many nodes are laid out, and the links among them.
   * Raising it lets a graph grow: a node joins beside one it is linked to.
   */
  active: number;
  tick(): void;
  settled(): boolean;
  /** Hold a node at a point, or let it go with `undefined`. */
  pin(index: number, at: { x: number; y: number } | undefined): void;
}

export function createForceLayout(options: ForceOptions): ForceLayout {
  const { radius, links } = options;
  const n = radius.length;
  const m = links.length / 2;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const pinX = new Float64Array(n).fill(NaN);
  const pinY = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(options.x[i])) {
      // d3's sunflower, so a new layout starts spread out and the same.
      const r = 10 * Math.sqrt(0.5 + i);
      const angle = i * Math.PI * (3 - Math.sqrt(5));
      x[i] = r * Math.cos(angle);
      y[i] = r * Math.sin(angle);
    } else {
      x[i] = options.x[i];
      y[i] = options.y[i];
    }
  }

  // A link pulls harder the fewer links its ends have, and moves the end
  // with fewer links more.
  const degree = new Uint32Array(n);
  for (let l = 0; l < links.length; l++) degree[links[l]]++;
  const linkStrength = new Float32Array(m);
  const linkBias = new Float32Array(m);
  for (let l = 0; l < m; l++) {
    const a = degree[links[2 * l]];
    const b = degree[links[2 * l + 1]];
    linkStrength[l] = options.linkStrength / Math.min(a, b);
    linkBias[l] = a / (a + b);
  }

  // A node that joins later starts beside a node before it that it links to.
  const anchor = new Int32Array(n).fill(-1);
  // How many links lie among the first k nodes, for each k.
  const linksAmong = new Uint32Array(n + 1);
  for (let l = 0; l < m; l++) {
    const a = links[2 * l];
    const b = links[2 * l + 1];
    const [low, high] = a < b ? [a, b] : [b, a];
    if (anchor[high] < 0 && low !== high) anchor[high] = low;
    linksAmong[high + 1]++;
  }
  for (let k = 1; k <= n; k++) linksAmong[k] += linksAmong[k - 1];
  const fresh = Uint8Array.from(options.x, (value) =>
    Number.isNaN(value) ? 1 : 0
  );
  let placed = n;

  let seed = 1;
  /** A tiny offset, so two nodes in one place have a direction to part in. */
  const jiggle = () => {
    seed = (seed * 1664525 + 1013904223) | 0;
    return ((seed >>> 8) / 16777216 - 0.5) * 1e-6;
  };

  // The quadtree of one tick, flat. A cell's four children are a cell
  // (index > 0), a leaf (-(node + 1)) or nothing (0); nodes sharing a leaf
  // chain through `next`.
  let capacity = 2 * n + 16;
  let child = new Int32Array(4 * capacity);
  let mass = new Float64Array(capacity);
  let comX = new Float64Array(capacity);
  let comY = new Float64Array(capacity);
  const next = new Int32Array(n);
  let cells = 0;
  let stackCell = new Int32Array(256);
  let stackSize = new Float64Array(256);

  function newCell(): number {
    if (cells === capacity) {
      capacity *= 2;
      const grow = <T extends Int32Array | Float64Array>(
        old: T,
        size: number
      ) => {
        const bigger = new (old.constructor as new (size: number) => T)(size);
        bigger.set(old);
        return bigger;
      };
      child = grow(child, 4 * capacity);
      mass = grow(mass, capacity);
      comX = grow(comX, capacity);
      comY = grow(comY, capacity);
    }
    const base = 4 * cells;
    child[base] = child[base + 1] = child[base + 2] = child[base + 3] = 0;
    return cells++;
  }

  // Each node's push from the others, before `alpha`.
  const pushX = new Float64Array(n);
  const pushY = new Float64Array(n);
  let ticks = 0;

  function charge(alpha: number, n: number) {
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      if (x[i] < minX) minX = x[i];
      if (x[i] > maxX) maxX = x[i];
      if (y[i] < minY) minY = y[i];
      if (y[i] > maxY) maxY = y[i];
    }
    const size = Math.max(maxX - minX, maxY - minY, 1e-9) * 1.0001;

    cells = 0;
    newCell();
    for (let i = 0; i < n; i++) {
      let cell = 0;
      let x0 = minX;
      let y0 = minY;
      let half = size / 2;
      for (let depth = 0; ; depth++) {
        const right = x[i] >= x0 + half ? 1 : 0;
        const down = y[i] >= y0 + half ? 1 : 0;
        const slot = 4 * cell + right + 2 * down;
        const c = child[slot];
        if (c === 0) {
          next[i] = -1;
          child[slot] = -(i + 1);
          break;
        }
        x0 += right * half;
        y0 += down * half;
        half /= 2;
        if (c > 0) {
          cell = c;
          continue;
        }
        const j = -c - 1;
        if (depth >= MAX_DEPTH || (x[j] === x[i] && y[j] === y[i])) {
          next[i] = j;
          child[slot] = -(i + 1);
          break;
        }
        // Split the leaf: the node in it moves one level down.
        const made = newCell();
        child[slot] = made;
        child[
          4 * made +
            (x[j] >= x0 + half ? 1 : 0) +
            2 * (y[j] >= y0 + half ? 1 : 0)
        ] = c;
        cell = made;
      }
    }
    // A cell is made after its parent, so backwards is children first.
    for (let cell = cells - 1; cell >= 0; cell--) {
      let total = 0;
      let sumX = 0;
      let sumY = 0;
      for (let q = 0; q < 4; q++) {
        const c = child[4 * cell + q];
        if (c > 0) {
          total += mass[c];
          sumX += comX[c] * mass[c];
          sumY += comY[c] * mass[c];
        } else {
          for (let j = -c - 1; j >= 0; j = next[j]) {
            total++;
            sumX += x[j];
            sumY += y[j];
          }
        }
      }
      mass[cell] = total;
      comX[cell] = sumX / total;
      comY[cell] = sumY / total;
    }

    const theta2 = options.theta * options.theta;
    const reach2 = options.chargeReach * options.chargeReach;
    const push = -options.repel;
    // The first tick has no earlier push to keep.
    const every = ticks === 0 ? 1 : Math.max(1, Math.floor(layout.chargeEvery));
    for (let i = ticks % every; i < n; i += every) {
      const xi = x[i];
      const yi = y[i];
      let ax = 0;
      let ay = 0;
      let top = 0;
      stackCell[0] = 0;
      stackSize[0] = size;
      while (top >= 0) {
        const cell = stackCell[top];
        const width = stackSize[top--] / 2;
        for (let q = 0; q < 4; q++) {
          const c = child[4 * cell + q];
          if (c === 0) continue;
          if (c > 0) {
            const dx = comX[c] - xi;
            const dy = comY[c] - yi;
            const d2 = dx * dx + dy * dy;
            // Far enough for its size: the whole cell acts as one node.
            if (width * width < theta2 * d2) {
              if (d2 < reach2) {
                const w = (mass[c] * push) / d2;
                ax += dx * w;
                ay += dy * w;
              }
              continue;
            }
            if (++top === stackCell.length) {
              const cellsGrown = new Int32Array(top * 2);
              cellsGrown.set(stackCell);
              stackCell = cellsGrown;
              const sizesGrown = new Float64Array(top * 2);
              sizesGrown.set(stackSize);
              stackSize = sizesGrown;
            }
            stackCell[top] = c;
            stackSize[top] = width;
            continue;
          }
          for (let j = -c - 1; j >= 0; j = next[j]) {
            if (j === i) continue;
            let dx = x[j] - xi;
            let dy = y[j] - yi;
            if (dx === 0) dx = jiggle();
            if (dy === 0) dy = jiggle();
            let d2 = dx * dx + dy * dy;
            if (d2 >= reach2) continue;
            // Closer than one unit, the push stops growing as fast.
            if (d2 < 1) d2 = Math.sqrt(d2);
            const w = push / d2;
            ax += dx * w;
            ay += dy * w;
          }
        }
      }
      pushX[i] = ax;
      pushY[i] = ay;
    }
    for (let i = 0; i < n; i++) {
      vx[i] += pushX[i] * alpha;
      vy[i] += pushY[i] * alpha;
    }
    ticks++;
  }

  function pull(alpha: number, m: number) {
    for (let l = 0; l < m; l++) {
      const a = links[2 * l];
      const b = links[2 * l + 1];
      let dx = x[b] + vx[b] - x[a] - vx[a];
      let dy = y[b] + vy[b] - y[a] - vy[a];
      if (dx === 0) dx = jiggle();
      if (dy === 0) dy = jiggle();
      const length = Math.sqrt(dx * dx + dy * dy);
      const k =
        ((length - options.linkDistance) / length) * alpha * linkStrength[l];
      dx *= k;
      dy *= k;
      const bias = linkBias[l];
      vx[b] -= dx * bias;
      vy[b] -= dy * bias;
      vx[a] += dx * (1 - bias);
      vy[a] += dy * (1 - bias);
    }
  }

  // Nodes by grid cell, each cell as wide as the widest pair that can touch.
  // Cells hash into a table, so two cells can share a slot: that only adds
  // nodes too far apart to touch, which the distance check drops.
  let slots = 16;
  while (slots < 2 * n) slots *= 2;
  const gridHead = new Int32Array(options.collide ? slots : 0);
  const gridNext = new Int32Array(options.collide ? n : 0);
  let maxRadius = 0;
  for (let i = 0; i < n; i++) maxRadius = Math.max(maxRadius, radius[i]);
  const gridSize = 2 * (maxRadius + COLLIDE_PAD);
  const slot = (cx: number, cy: number) =>
    (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) & (slots - 1);

  function collide(n: number) {
    gridHead.fill(-1);
    for (let i = 0; i < n; i++) {
      const k = slot(
        Math.floor((x[i] + vx[i]) / gridSize),
        Math.floor((y[i] + vy[i]) / gridSize)
      );
      gridNext[i] = gridHead[k];
      gridHead[k] = i;
    }
    for (let i = 0; i < n; i++) {
      const xi = x[i] + vx[i];
      const yi = y[i] + vy[i];
      const ri = radius[i] + COLLIDE_PAD;
      const cx = Math.floor(xi / gridSize);
      const cy = Math.floor(yi / gridSize);
      // A pair is met once: in its own cell from the lower index, and
      // across cells from the one whose cell comes first.
      for (let c = 0; c < 5; c++) {
        {
          const gx = cx + (c === 0 || c === 4 ? 0 : 1);
          const gy = cy + (c === 0 ? 0 : c === 4 ? 1 : c - 2);
          for (let j = gridHead[slot(gx, gy)]; j >= 0; j = gridNext[j]) {
            if (c === 0 && j <= i) continue;
            const rj = radius[j] + COLLIDE_PAD;
            const r = ri + rj;
            let dx = xi - x[j] - vx[j];
            let dy = yi - y[j] - vy[j];
            let d2 = dx * dx + dy * dy;
            if (d2 >= r * r) continue;
            if (dx === 0) d2 += (dx = jiggle()) * dx;
            if (dy === 0) d2 += (dy = jiggle()) * dy;
            const d = Math.sqrt(d2);
            const k = (r - d) / d;
            dx *= k;
            dy *= k;
            // The bigger node gives way less.
            const share = (rj * rj) / (ri * ri + rj * rj);
            vx[i] += dx * share;
            vy[i] += dy * share;
            vx[j] -= dx * (1 - share);
            vy[j] -= dy * (1 - share);
          }
        }
      }
    }
  }

  const layout: ForceLayout = {
    x,
    y,
    alpha: options.alpha,
    alphaTarget: 0,
    chargeEvery: 1,
    active: n,
    tick() {
      const count = Math.min(Math.max(Math.floor(layout.active), 0), n);
      if (count < placed) placed = count;
      for (; placed < count; placed++) {
        const beside = anchor[placed];
        if (!fresh[placed] || beside < 0) continue;
        x[placed] = x[beside] + jiggle() * 4e7;
        y[placed] = y[beside] + jiggle() * 4e7;
      }
      layout.alpha += (layout.alphaTarget - layout.alpha) * options.alphaDecay;
      const alpha = layout.alpha;
      if (count > 1) charge(alpha, count);
      pull(alpha, linksAmong[count]);
      for (let i = 0; i < count; i++) {
        vx[i] -= x[i] * options.centre * alpha;
        vy[i] -= y[i] * options.centre * alpha;
      }
      if (options.collide) collide(count);
      for (let i = 0; i < count; i++) {
        if (Number.isNaN(pinX[i])) {
          x[i] += vx[i] *= VELOCITY_KEEP;
          y[i] += vy[i] *= VELOCITY_KEEP;
        } else {
          x[i] = pinX[i];
          y[i] = pinY[i];
          vx[i] = vy[i] = 0;
        }
      }
    },
    settled: () => layout.alpha < ALPHA_MIN && layout.alphaTarget === 0,
    pin(index, at) {
      pinX[index] = at?.x ?? NaN;
      pinY[index] = at?.y ?? NaN;
    }
  };
  return layout;
}
