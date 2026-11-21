/**
 * What a schema view's `graph` node draws. The plugin names the notes; the
 * host adds the links between them from its own index of note bodies, so a
 * plugin with `notes.read` learns nothing about bodies it couldn't already.
 */

import type { ViewGraphNode, ViewNode } from './view-schema';

type GraphNode = Extract<ViewNode, { type: 'graph' }>;

export interface VisibleGraph {
  nodes: ViewGraphNode[];
  /** Undirected: each pair of linked notes appears once. */
  links: [string, string][];
}

/** The nodes and links to draw for `node`, given every note's outgoing links. */
export function visibleGraph(
  node: Pick<GraphNode, 'nodes' | 'links' | 'focus' | 'depth' | 'orphans'>,
  outgoing: Map<string, string[]>
): VisibleGraph {
  const allowed = new Map(node.nodes.map((n) => [n.id, n]));
  const pairs = node.links.filter(
    ([a, b]) => a !== b && allowed.has(a) && allowed.has(b)
  );
  for (const [source, targets] of outgoing) {
    if (!allowed.has(source)) continue;
    for (const target of targets) {
      if (target !== source && allowed.has(target))
        pairs.push([source, target]);
    }
  }
  const neighbours = adjacency(pairs);

  let shown = new Set(allowed.keys());
  if (node.focus !== undefined) {
    shown = new Set();
    if (allowed.has(node.focus)) {
      let frontier = [node.focus];
      shown.add(node.focus);
      for (let step = 0; step < node.depth && frontier.length; step++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const n of neighbours.get(id) ?? []) {
            if (!shown.has(n)) {
              shown.add(n);
              next.push(n);
            }
          }
        }
        frontier = next;
      }
    }
  }
  if (!node.orphans) {
    shown = new Set(
      [...shown].filter(
        (id) =>
          id === node.focus ||
          [...(neighbours.get(id) ?? [])].some((n) => shown.has(n))
      )
    );
  }

  const links: [string, string][] = [];
  for (const id of shown) {
    for (const n of neighbours.get(id) ?? []) {
      if (id < n && shown.has(n)) links.push([id, n]);
    }
  }
  return {
    nodes: node.nodes.filter((n) => shown.has(n.id)),
    links
  };
}

/** Each note's linked notes. */
export function adjacency(links: [string, string][]): Map<string, Set<string>> {
  const neighbours = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    let set = neighbours.get(a);
    if (!set) neighbours.set(a, (set = new Set()));
    set.add(b);
  };
  for (const [a, b] of links) {
    add(a, b);
    add(b, a);
  }
  return neighbours;
}
