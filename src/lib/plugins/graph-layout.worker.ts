/**
 * The force layout of a schema view's `graph`, off the main thread. A layout
 * of tens of thousands of nodes takes tens of milliseconds a tick, which on
 * the page would stall every frame and input.
 *
 * The page sends a layout's links and starting positions by node index and
 * gets positions back, at most one batch per frame. A layout's `version`
 * tags its positions, since indexes mean nothing once the page has sent the
 * next layout.
 */
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationNodeDatum
} from 'd3-force';
import type { LayoutRequest, LayoutPositions } from './graph-layout';

interface Node extends SimulationNodeDatum {
  radius: number;
}

// Past this many nodes collisions cost more than they show, and the layout
// cools in about 90 ticks rather than d3's 300: each tick is slow there, and
// every one redraws the whole graph. Repulsion also reaches the whole graph,
// or the pull to the centre packs it into a heap of overlapping nodes.
const LARGE = 5000;
const LARGE_ALPHA_DECAY = 0.05;
// A new layout ticks this long before its first positions, so it opens mostly
// settled rather than exploding outwards.
const WARMUP_MS = 300;
const FRAME_MS = 16;

const NEAR = 400;
const charge = forceManyBody<Node>().strength(-60);
// Links name nodes by index, forceLink's default id.
const links = forceLink<Node, { source: number; target: number }>([]).distance(
  40
);
const collide = forceCollide<Node>((n) => n.radius + 2);
const simulation = forceSimulation<Node>([])
  .force('charge', charge)
  .force('link', links)
  .force('x', forceX<Node>(0).strength(0.04))
  .force('y', forceY<Node>(0).strength(0.04))
  .stop();

let version = 0;
let nodes: Node[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function post() {
  const x = new Float32Array(nodes.length);
  const y = new Float32Array(nodes.length);
  nodes.forEach((n, i) => {
    x[i] = n.x!;
    y[i] = n.y!;
  });
  const message: LayoutPositions = { version, x, y };
  postMessage(message, { transfer: [x.buffer, y.buffer] });
}

function settled() {
  return (
    simulation.alpha() < simulation.alphaMin() && simulation.alphaTarget() === 0
  );
}

function run() {
  timer = null;
  // One tick a frame. A small graph ticks in microseconds, and ticking it for
  // a whole frame would finish the layout between two messages: the page
  // would see it jump, and a dragged node would snap back on release.
  const start = performance.now();
  simulation.tick();
  post();
  if (!settled())
    timer = setTimeout(
      run,
      Math.max(0, FRAME_MS - (performance.now() - start))
    );
}

function wake() {
  if (timer === null) timer = setTimeout(run, 0);
}

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const request = event.data;
  switch (request.type) {
    case 'layout': {
      version = request.version;
      nodes = Array.from(request.radius, (radius, i) => {
        const node: Node = { radius, index: i };
        if (!Number.isNaN(request.x[i])) {
          node.x = request.x[i];
          node.y = request.y[i];
        }
        return node;
      });
      simulation.nodes(nodes);
      const pairs = [];
      for (let i = 0; i < request.links.length; i += 2)
        pairs.push({ source: request.links[i], target: request.links[i + 1] });
      links.links(pairs);
      const large = nodes.length > LARGE;
      simulation.force('collide', large ? null : collide);
      charge.distanceMax(large ? Infinity : NEAR);
      simulation.alphaDecay(large ? LARGE_ALPHA_DECAY : 1 - 0.001 ** (1 / 300));
      // A drag from the layout this one replaces never gets its release.
      simulation.alphaTarget(0);
      simulation.alpha(request.alpha);
      if (request.warmup) {
        const until = performance.now() + WARMUP_MS;
        while (performance.now() < until && !settled()) simulation.tick();
      }
      post();
      wake();
      return;
    }
    case 'drag': {
      const node = nodes[request.index];
      if (request.version !== version || !node) return;
      node.fx = request.x;
      node.fy = request.y;
      simulation.alphaTarget(0.3);
      wake();
      return;
    }
    case 'release': {
      const node = nodes[request.index];
      if (request.version !== version || !node) return;
      node.fx = null;
      node.fy = null;
      simulation.alphaTarget(0);
      wake();
      return;
    }
  }
};
