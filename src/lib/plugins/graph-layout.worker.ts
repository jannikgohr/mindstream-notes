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
import { createForceLayout, type ForceLayout } from './graph-force';
import type { LayoutRequest, LayoutPositions } from './graph-layout';

// Past this many nodes the layout cools in about 90 ticks rather than 300:
// each tick is slow there, and every one redraws the whole graph. Repulsion
// also reaches the whole graph, or the pull to the centre packs it into a
// heap, and that pull is doubled so unlinked notes ring the rest closely.
const LARGE = 5000;
const LARGE_ALPHA_DECAY = 0.05;
const ALPHA_DECAY = 1 - 0.001 ** (1 / 300);
const NEAR = 400;
const CENTRE = 0.04;
const REPEL = 60;
// With more links a node than this, links pull in proportion less. At full
// strength they squeeze a densely linked vault into a lopsided clump with
// its unlinked notes far outside; this keeps it a disc.
const FULL_STRENGTH_LINKS = 6;
// A new layout ticks this long before its first positions, so it opens mostly
// settled rather than exploding outwards.
const WARMUP_MS = 300;
const FRAME_MS = 16;
// Windows wakes a timer on a 15.6 ms beat unless something asks for finer:
// a wait of 16 ms lasts 31. Asking for a little less lands on the first beat.
const TIMER_SLACK_MS = 2;

let version = 0;
let layout: ForceLayout | undefined;
let timer: ReturnType<typeof setTimeout> | null = null;
// A growing layout: when it started and how long it takes.
let grow: { from: number; ms: number; nodes: number } | undefined;
let dragging = false;
// What keeps a growing or dragged layout moving.
const LIVELY = 0.3;
// Repulsion is spread over up to this many ticks to keep a tick in a frame.
const MAX_CHARGE_EVERY = 8;

/** One tick, then repulsion spread wider or narrower by how long it took. */
function tick(layout: ForceLayout) {
  const start = performance.now();
  if (grow) {
    // Slow at first, when each new node still changes the picture.
    const done = Math.min((start - grow.from) / grow.ms, 1);
    layout.active = Math.max(1, Math.ceil(grow.nodes * done * done));
    if (done === 1) {
      grow = undefined;
      if (!dragging) layout.alphaTarget = 0;
    }
  }
  layout.tick();
  const took = performance.now() - start;
  if (took > FRAME_MS && layout.chargeEvery < MAX_CHARGE_EVERY)
    layout.chargeEvery++;
  else if (took < FRAME_MS / 2 && layout.chargeEvery > 1) layout.chargeEvery--;
}

function post() {
  if (!layout) return;
  const nodes = layout.state.length / 4;
  const x = new Float32Array(nodes);
  const y = new Float32Array(nodes);
  for (let i = 0; i < nodes; i++) {
    x[i] = layout.state[4 * i];
    y[i] = layout.state[4 * i + 1];
  }
  const message: LayoutPositions = { version, active: layout.active, x, y };
  postMessage(message, { transfer: [x.buffer, y.buffer] });
}

function run() {
  timer = null;
  if (!layout) return;
  // One tick a frame. A small graph ticks in microseconds, and ticking it for
  // a whole frame would finish the layout between two messages: the page
  // would see it jump, and a dragged node would snap back on release.
  const start = performance.now();
  tick(layout);
  post();
  if (!layout.settled())
    timer = setTimeout(
      run,
      Math.max(0, FRAME_MS - TIMER_SLACK_MS - (performance.now() - start))
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
      const large = request.radius.length > LARGE;
      // A drag from the layout this one replaces never gets its release:
      // the new layout starts with nothing held.
      layout = createForceLayout({
        radius: request.radius,
        x: request.x,
        y: request.y,
        links: request.links,
        alpha: request.alpha,
        alphaDecay: large ? LARGE_ALPHA_DECAY : ALPHA_DECAY,
        chargeReach: large ? Infinity : NEAR,
        // Coarser grouping settles a big graph into the same shape, sooner.
        theta: large ? 1.2 : 0.9,
        collide: true,
        centre: (large ? 2 * CENTRE : CENTRE) * request.forces.centre,
        repel: REPEL * request.forces.repel,
        linkDistance: request.forces.linkDistance,
        linkStrength:
          request.forces.link *
          Math.min(
            1,
            (FULL_STRENGTH_LINKS * request.radius.length) / request.links.length
          )
      });
      dragging = false;
      grow = undefined;
      if (request.grow) {
        grow = {
          from: performance.now(),
          ms: request.grow,
          nodes: request.radius.length
        };
        layout.active = 0;
        layout.alphaTarget = LIVELY;
      } else if (request.warmup) {
        const until = performance.now() + WARMUP_MS;
        while (performance.now() < until && !layout.settled()) tick(layout);
      }
      post();
      wake();
      return;
    }
    case 'drag': {
      if (request.version !== version || !layout) return;
      layout.pin(request.index, request);
      dragging = true;
      layout.alphaTarget = LIVELY;
      wake();
      return;
    }
    case 'release': {
      if (request.version !== version || !layout) return;
      layout.pin(request.index, undefined);
      dragging = false;
      if (!grow) layout.alphaTarget = 0;
      wake();
      return;
    }
  }
};
