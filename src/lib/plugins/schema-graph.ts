/**
 * What a schema view's `graph` node draws. The plugin names the notes; the
 * host adds the links between them from its own index of note bodies, so a
 * plugin with `notes.read` learns nothing about bodies it couldn't already.
 *
 * Everything past the first lookup is by node index in typed arrays: a vault
 * of tens of thousands of notes has hundreds of thousands of links, and a
 * set of strings per note costs most of a second to build.
 */

import type { ViewGraphNode, ViewNode } from './view-schema';

type GraphNode = Extract<ViewNode, { type: 'graph' }>;

export interface GraphIndex {
  /** What is drawn, oldest first: the order a growing graph adds them in. */
  nodes: ViewGraphNode[];
  /** Index pairs, each linked pair once, ordered by its higher end. */
  pairs: Uint32Array<ArrayBuffer>;
  /** `linksAmong[k]` is how many of `pairs` lie among the first `k` nodes. */
  linksAmong: Uint32Array<ArrayBuffer>;
  /** Node `i` is linked to `adjacent[offset[i]]` up to `offset[i + 1]`. */
  offset: Uint32Array<ArrayBuffer>;
  adjacent: Uint32Array<ArrayBuffer>;
}

function adjacency(
  nodes: number,
  a: Uint32Array,
  b: Uint32Array,
  links: number
) {
  const offset = new Uint32Array(nodes + 1);
  for (let l = 0; l < links; l++) {
    offset[a[l] + 1]++;
    offset[b[l] + 1]++;
  }
  for (let i = 0; i < nodes; i++) offset[i + 1] += offset[i];
  const next = offset.slice(0, nodes);
  const adjacent = new Uint32Array(2 * links);
  for (let l = 0; l < links; l++) {
    adjacent[next[a[l]]++] = b[l];
    adjacent[next[b[l]]++] = a[l];
  }
  return { offset, adjacent };
}

/**
 * The nodes and links to draw for `node`, given every note's outgoing links.
 * `age` orders the nodes: a note's creation time, say. A node it has no
 * number for, such as a tag, comes with the first node it is linked to.
 */
export function indexGraph(
  node: Pick<GraphNode, 'nodes' | 'links' | 'focus' | 'depth' | 'orphans'>,
  outgoing: Map<string, string[]>,
  age: (id: string) => number = () => 0
): GraphIndex {
  const all = node.nodes;
  const count = all.length;
  const at = new Map<string, number>();
  all.forEach((given, i) => at.set(given.id, i));

  // Every link between two given nodes, from its lower end to its higher.
  let most = node.links.length;
  for (const targets of outgoing.values()) most += targets.length;
  const from = new Uint32Array(most);
  const to = new Uint32Array(most);
  let found = 0;
  const link = (i: number | undefined, j: number | undefined) => {
    if (i === undefined || j === undefined || i === j) return;
    from[found] = Math.min(i, j);
    to[found++] = Math.max(i, j);
  };
  for (const [a, b] of node.links) link(at.get(a), at.get(b));
  for (const [source, targets] of outgoing) {
    const i = at.get(source);
    if (i === undefined) continue;
    for (const target of targets) link(i, at.get(target));
  }
  // Each linked pair once: grouped by lower end, a pair seen again under the
  // same lower end is a repeat.
  const group = new Uint32Array(count + 1);
  for (let l = 0; l < found; l++) group[from[l] + 1]++;
  for (let i = 0; i < count; i++) group[i + 1] += group[i];
  const fill = group.slice(0, count);
  const grouped = new Uint32Array(found);
  for (let l = 0; l < found; l++) grouped[fill[from[l]]++] = to[l];
  const seenFrom = new Int32Array(count).fill(-1);
  const low = new Uint32Array(found);
  const high = new Uint32Array(found);
  let links = 0;
  for (let i = 0; i < count; i++) {
    for (let k = group[i]; k < group[i + 1]; k++) {
      const j = grouped[k];
      if (seenFrom[j] === i) continue;
      seenFrom[j] = i;
      low[links] = i;
      high[links++] = j;
    }
  }
  const given = adjacency(count, low, high, links);

  let shown = new Uint8Array(count).fill(1);
  const focus = node.focus === undefined ? undefined : at.get(node.focus);
  if (node.focus !== undefined) {
    shown.fill(0);
    let frontier = focus === undefined ? [] : [focus];
    for (const i of frontier) shown[i] = 1;
    for (let step = 0; step < node.depth && frontier.length; step++) {
      const next: number[] = [];
      for (const i of frontier) {
        for (let e = given.offset[i]; e < given.offset[i + 1]; e++) {
          const j = given.adjacent[e];
          if (shown[j]) continue;
          shown[j] = 1;
          next.push(j);
        }
      }
      frontier = next;
    }
  }
  if (!node.orphans) {
    const linked = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      if (!shown[i]) continue;
      if (i === focus) linked[i] = 1;
      for (let e = given.offset[i]; e < given.offset[i + 1] && !linked[i]; e++)
        linked[i] = shown[given.adjacent[e]];
    }
    shown = linked;
  }

  const ages = Float64Array.from(all, (one) => age(one.id));
  const when = Float64Array.from(ages);
  // Among nodes of one age, the given order; a node without an age goes
  // straight after the node it takes its age from.
  const rank = Float64Array.from(all, (_, i) => i);
  for (let i = 0; i < count; i++) {
    if (Number.isFinite(ages[i])) continue;
    when[i] = Infinity;
    for (let e = given.offset[i]; e < given.offset[i + 1]; e++) {
      const linked = given.adjacent[e];
      if (ages[linked] < when[i]) {
        when[i] = ages[linked];
        rank[i] = linked + 0.5;
      }
    }
  }
  const order: number[] = [];
  for (let i = 0; i < count; i++) if (shown[i]) order.push(i);
  // Two with no age at all compare as NaN, which falls through to the rank.
  order.sort((a, b) => when[a] - when[b] || rank[a] - rank[b] || a - b);
  const renumbered = new Int32Array(count).fill(-1);
  order.forEach((old, i) => (renumbered[old] = i));

  const nodes = order.length;
  const linksAmong = new Uint32Array(nodes + 1);
  for (let l = 0; l < links; l++) {
    const a = renumbered[low[l]];
    const b = renumbered[high[l]];
    if (a >= 0 && b >= 0) linksAmong[Math.max(a, b) + 1]++;
  }
  for (let i = 0; i < nodes; i++) linksAmong[i + 1] += linksAmong[i];
  const next = linksAmong.slice(0, nodes);
  const drawn = linksAmong[nodes];
  const pairs = new Uint32Array(2 * drawn);
  const ends = [new Uint32Array(drawn), new Uint32Array(drawn)];
  for (let l = 0; l < links; l++) {
    const a = renumbered[low[l]];
    const b = renumbered[high[l]];
    if (a < 0 || b < 0) continue;
    const slot = next[Math.max(a, b)]++;
    ends[0][slot] = pairs[2 * slot] = a;
    ends[1][slot] = pairs[2 * slot + 1] = b;
  }
  return {
    nodes: order.map((i) => all[i]),
    pairs,
    linksAmong,
    ...adjacency(nodes, ends[0], ends[1], drawn)
  };
}
