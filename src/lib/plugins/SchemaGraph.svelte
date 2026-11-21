<script lang="ts">
  /**
   * The `graph` node of a schema view: notes as a force-directed graph of
   * their links, on a canvas. Drag a note to move it, drag the background (or
   * anywhere with the middle or right button) to pan, scroll to zoom, click
   * a note to send `onSelect`. The layout runs in
   * a worker (see graph-layout.worker.ts); this side only draws: links and
   * nodes with WebGL (see graph-renderer.ts), labels on a 2D canvas above.
   * Without WebGL the 2D canvas draws everything.
   */
  import { untrack } from 'svelte';
  import { loadNoteLinks } from '$lib/notes/note-relations';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { tree } from '$lib/stores/tree.svelte';
  import { startLayoutWorker, type LayoutPositions } from './graph-layout';
  import {
    createGraphRenderer,
    NODE_ACCENT,
    NODE_LIT,
    NODE_RING,
    PALETTE_SIZE,
    rgba,
    type GraphRenderer
  } from './graph-renderer';
  import { adjacency, visibleGraph } from './schema-graph';
  import type { ViewNode } from './view-schema';

  type GraphNode = Extract<ViewNode, { type: 'graph' }>;
  let {
    node,
    onEvent
  }: {
    node: GraphNode;
    onEvent: (event: string, value: string) => void;
  } = $props();

  // Code stores a colour's name; the theme decides its value (see app.css).
  const GROUP_COLOURS = [
    'blue',
    'green',
    'orange',
    'violet',
    'teal',
    'pink',
    'amber',
    'red'
  ];
  const MUTED = -1;
  const DRAG_THRESHOLD = 4;
  // Labels drawn at once, biggest nodes first, beyond the hovered note's.
  const MAX_LABELS = 250;
  // Below this many pixels across, a node is drawn as a square: much cheaper
  // than an arc, and the same at that size.
  const DOT_PX = 3;

  let canvas = $state<HTMLCanvasElement>();
  let glCanvas = $state<HTMLCanvasElement>();
  let renderer: GraphRenderer | null = null;
  // The renderer still holds the layout before this one, until this one's
  // first positions arrive: new nodes have no place to be drawn at yet.
  let sceneStale = true;
  let width = $state(0);
  let height = $state(0);
  let outgoing = $state(new Map<string, string[]>());
  let linksLoaded = $state(false);
  let empty = $state(false);
  let shownNodes = $state(0);
  let shownLinks = $state(0);

  // The drawn layout, by node index.
  let ids: string[] = [];
  let indexOf = new Map<string, number>();
  let labels: string[] = [];
  let other = new Uint8Array(0);
  let colour = new Int8Array(0);
  let radius = new Float32Array(0);
  let xs = new Float32Array(0);
  let ys = new Float32Array(0);
  let pairs = new Uint32Array(0);
  // Indexes from the biggest node down, the order labels are drawn in.
  let byRadius = new Uint32Array(0);
  // Indexes by how they're drawn: colour, then disc or ring.
  let buckets: { colour: number; ring: boolean; nodes: Uint32Array }[] = [];
  let neighbours = adjacency([]);
  let version = 0;
  let hovered = -1;
  let camera = { x: 0, y: 0, k: 1 };
  let fittedFocus: string | undefined;
  // The camera follows the layout until the user moves it: positions keep
  // changing while a layout settles, so one fit would frame a stale box.
  let autoFit = true;
  let frame = 0;

  const layout = startLayoutWorker(onPositions);

  $effect(() => {
    if (!glCanvas) return;
    const el = glCanvas;
    const made = createGraphRenderer(el);
    renderer = made;
    sceneStale = true;
    // A lost context draws nothing more: carry on in 2D.
    const onLost = () => {
      renderer = null;
      schedule();
    };
    el.addEventListener('webglcontextlost', onLost);
    return () => {
      el.removeEventListener('webglcontextlost', onLost);
      renderer = null;
      made?.destroy();
    };
  });

  /** Each node's colour and whether it is a ring, lit or the accent. */
  function nodeStyles(): Uint8Array {
    const focus =
      node.focus === undefined ? -1 : (indexOf.get(node.focus) ?? -1);
    const lit = hovered >= 0 ? neighbours.get(ids[hovered]) : undefined;
    const styles = new Uint8Array(ids.length * 2);
    for (let i = 0; i < ids.length; i++) {
      styles[2 * i] = colour[i] === MUTED ? PALETTE_SIZE - 2 : colour[i];
      styles[2 * i + 1] =
        (other[i] ? NODE_RING : 0) |
        (lit?.has(ids[i]) ? NODE_LIT : 0) |
        (i === focus || i === hovered ? NODE_ACCENT : 0);
    }
    return styles;
  }

  /** Tell the renderer which node is hovered. */
  function showHover() {
    if (!renderer || sceneStale) return;
    renderer.setStyles(nodeStyles());
    const lit: number[] = [];
    if (hovered >= 0) {
      for (let p = 0; p < pairs.length; p += 2) {
        if (pairs[p] === hovered || pairs[p + 1] === hovered)
          lit.push(pairs[p], pairs[p + 1]);
      }
    }
    renderer.setLitLinks(Uint32Array.from(lit));
  }

  /** A group's colour from its name, so it is the same in every view. */
  function groupColour(group: string): number {
    let hash = 0;
    for (let i = 0; i < group.length; i++)
      hash = (hash * 31 + group.charCodeAt(i)) | 0;
    return Math.abs(hash) % GROUP_COLOURS.length;
  }

  function onPositions(positions: LayoutPositions) {
    if (positions.version !== version) return;
    xs = positions.x;
    ys = positions.y;
    if (renderer) {
      if (sceneStale) {
        renderer.setScene({ links: pairs, radius, styles: nodeStyles() });
        sceneStale = false;
        showHover();
      }
      renderer.setPositions(xs, ys);
    }
    fit();
    schedule();
  }

  // Bodies are read and cached by the host; a redraw only reloads the notes
  // whose `modified` changed.
  $effect(() => {
    const summaries = Object.values(tree.notesById);
    let cancelled = false;
    void loadNoteLinks(summaries).then((next) => {
      if (cancelled) return;
      outgoing = next;
      linksLoaded = true;
    });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const graph = visibleGraph(node, outgoing);
    const titles = tree.notesById;
    untrack(() => relayout(graph, titles));
  });

  function relayout(
    graph: ReturnType<typeof visibleGraph>,
    titles: typeof tree.notesById
  ) {
    const previous = indexOf;
    const [oldX, oldY] = [xs, ys];
    const n = graph.nodes.length;
    const nextIds = graph.nodes.map((g) => g.id);
    const nextIndex = new Map(nextIds.map((id, i) => [id, i]));
    const nextPairs = new Uint32Array(graph.links.length * 2);
    graph.links.forEach(([a, b], i) => {
      nextPairs[2 * i] = nextIndex.get(a)!;
      nextPairs[2 * i + 1] = nextIndex.get(b)!;
    });
    labels = graph.nodes.map((g) => g.label ?? titles[g.id]?.title ?? '');
    // Most redraws come from an edit that changed no link: keep the layout.
    const same =
      nextIds.length === ids.length &&
      nextIds.every((id, i) => id === ids[i]) &&
      nextPairs.length === pairs.length &&
      nextPairs.every((v, i) => v === pairs[i]);
    if (same && node.focus === fittedFocus) {
      schedule();
      return;
    }
    neighbours = adjacency(graph.links);

    ids = nextIds;
    indexOf = nextIndex;
    other = Uint8Array.from(graph.nodes, (g) =>
      g.label === undefined ? 0 : 1
    );
    colour = Int8Array.from(graph.nodes, (g) =>
      g.group === undefined ? MUTED : groupColour(g.group)
    );
    radius = Float32Array.from(
      ids,
      (id) => 3 + Math.min(Math.sqrt(neighbours.get(id)?.size ?? 0) * 1.5, 9)
    );
    xs = new Float32Array(n).fill(NaN);
    ys = new Float32Array(n).fill(NaN);
    let kept = 0;
    ids.forEach((id, i) => {
      const old = previous.get(id);
      if (old !== undefined) {
        xs[i] = oldX[old];
        ys[i] = oldY[old];
        kept++;
        return;
      }
      // A node new to the view starts beside a node it links to.
      for (const near of neighbours.get(id) ?? []) {
        const j = previous.get(near);
        if (j === undefined || Number.isNaN(oldX[j])) continue;
        xs[i] = oldX[j] + (Math.random() - 0.5) * 20;
        ys[i] = oldY[j] + (Math.random() - 0.5) * 20;
        break;
      }
    });
    pairs = nextPairs;
    buckets = [];
    for (let c = MUTED; c < GROUP_COLOURS.length; c++) {
      for (const ring of [false, true]) {
        const members = Uint32Array.from(ids.keys()).filter(
          (i) => colour[i] === c && (other[i] === 1) === ring
        );
        if (members.length) buckets.push({ colour: c, ring, nodes: members });
      }
    }
    byRadius = Uint32Array.from(ids.keys()).sort(
      (a, b) => radius[b] - radius[a]
    );
    hovered = -1;
    sceneStale = true;
    empty = n === 0;
    shownNodes = n;
    shownLinks = graph.links.length;
    if (kept === 0 || node.focus !== fittedFocus) autoFit = true;

    version++;
    layout.send({
      type: 'layout',
      version,
      radius: radius.slice(),
      x: xs.slice(),
      y: ys.slice(),
      links: pairs.slice(),
      alpha: kept === 0 ? 1 : kept < n ? 0.5 : 0.1,
      warmup: kept === 0
    });
    schedule();
  }

  /** Zoom and centre on every node, at most to twice the natural size. */
  function fit() {
    if (!autoFit || !width || !height || !ids.length) return;
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < ids.length; i++) {
      if (Number.isNaN(xs[i])) continue;
      minX = Math.min(minX, xs[i]);
      minY = Math.min(minY, ys[i]);
      maxX = Math.max(maxX, xs[i]);
      maxY = Math.max(maxY, ys[i]);
    }
    if (minX === Infinity) return;
    fittedFocus = node.focus;
    const pad = 40;
    const k = Math.min(
      width / (maxX - minX + pad * 2),
      height / (maxY - minY + pad * 2),
      2
    );
    camera = {
      k,
      x: -((minX + maxX) / 2) * k,
      y: -((minY + maxY) / 2) * k
    };
    schedule();
  }

  $effect(() => {
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    if (glCanvas) {
      glCanvas.width = canvas.width;
      glCanvas.height = canvas.height;
    }
    untrack(fit);
    schedule();
  });

  $effect(() => {
    if (!canvas) return;
    const el = canvas;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  $effect(() => () => {
    layout.stop();
    cancelAnimationFrame(frame);
  });

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  function toWorld(sx: number, sy: number) {
    return {
      x: (sx - width / 2 - camera.x) / camera.k,
      y: (sy - height / 2 - camera.y) / camera.k
    };
  }

  function nodeAt(sx: number, sy: number): number {
    const { x, y } = toWorld(sx, sy);
    for (let i = ids.length - 1; i >= 0; i--) {
      const hit = radius[i] + 4 / camera.k;
      if ((xs[i] - x) ** 2 + (ys[i] - y) ** 2 <= hit * hit) return i;
    }
    return -1;
  }

  function draw() {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const css = getComputedStyle(canvas);
    const token = (name: string) => css.getPropertyValue(name).trim();
    const fills = GROUP_COLOURS.map((c) => token(`--named-${c}`));
    const muted = token('--muted-foreground');
    const accent = token('--accent-brand');
    const ratio = canvas.width / Math.max(width, 1);
    const { k } = camera;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Fainter the more links there are, or a dense graph is one grey slab.
    const linkAlpha =
      (hovered >= 0 ? 0.15 : 0.6) *
      Math.min(1, Math.sqrt(20000 / Math.max(pairs.length / 2, 1)));
    if (renderer) {
      const palette = new Float32Array(PALETTE_SIZE * 4);
      [...fills, muted, accent].forEach((c, i) => palette.set(rgba(c), i * 4));
      renderer.draw({
        width,
        height,
        ratio,
        x: camera.x,
        y: camera.y,
        k,
        palette,
        link: rgba(token('--border-strong'), linkAlpha),
        litLink: rgba(accent, 0.9),
        dimOthers: hovered >= 0
      });
    }
    ctx.setTransform(
      ratio * k,
      0,
      0,
      ratio * k,
      ratio * (width / 2 + camera.x),
      ratio * (height / 2 + camera.y)
    );

    // The world rectangle on screen, a little larger so big nodes at the
    // edge still draw.
    const margin = 20 / k;
    const left = toWorld(0, 0).x - margin;
    const top = toWorld(0, 0).y - margin;
    const right = toWorld(width, height).x + margin;
    const bottom = toWorld(width, height).y + margin;
    const outside = (i: number) =>
      !(xs[i] >= left && xs[i] <= right && ys[i] >= top && ys[i] <= bottom);

    const focus =
      node.focus === undefined ? -1 : (indexOf.get(node.focus) ?? -1);
    const lit = hovered >= 0 ? neighbours.get(ids[hovered]) : undefined;
    const isLit = (i: number) => i === hovered || (lit?.has(ids[i]) ?? false);

    if (!renderer) {
      // Links, in one path: one stroke for all of them is what keeps a big
      // graph fast. The hovered note's links go on top in the accent colour.
      ctx.lineWidth = 1 / k;
      ctx.strokeStyle = token('--border-strong');
      ctx.globalAlpha = linkAlpha;
      ctx.beginPath();
      const litLinks: number[] = [];
      for (let p = 0; p < pairs.length; p += 2) {
        const a = pairs[p];
        const b = pairs[p + 1];
        if (Number.isNaN(xs[a]) || Number.isNaN(xs[b])) continue;
        if (
          (xs[a] < left && xs[b] < left) ||
          (xs[a] > right && xs[b] > right) ||
          (ys[a] < top && ys[b] < top) ||
          (ys[a] > bottom && ys[b] > bottom)
        )
          continue;
        if (hovered >= 0 && (a === hovered || b === hovered)) {
          litLinks.push(a, b);
          continue;
        }
        ctx.moveTo(xs[a], ys[a]);
        ctx.lineTo(xs[b], ys[b]);
      }
      ctx.stroke();
      if (litLinks.length) {
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = accent;
        ctx.beginPath();
        for (let p = 0; p < litLinks.length; p += 2) {
          ctx.moveTo(xs[litLinks[p]], ys[litLinks[p]]);
          ctx.lineTo(xs[litLinks[p + 1]], ys[litLinks[p + 1]]);
        }
        ctx.stroke();
      }

      // Nodes, one path per colour. With a note hovered, the rest are dimmed
      // in a first pass and its neighbourhood drawn at full strength after.
      const pass = (wantLit: boolean, alpha: number) => {
        ctx.globalAlpha = alpha;
        // Tags and the like are rings, so no group colour is mistaken for
        // them.
        for (const bucket of buckets) {
          const { ring } = bucket;
          const style = bucket.colour === MUTED ? muted : fills[bucket.colour];
          {
            ctx.beginPath();
            let any = false;
            for (const i of bucket.nodes) {
              if (i === focus || i === hovered) continue;
              if (lit && isLit(i) !== wantLit) continue;
              if (Number.isNaN(xs[i]) || outside(i)) continue;
              any = true;
              const r = radius[i];
              if (!ring && r * 2 * k < DOT_PX) {
                ctx.rect(xs[i] - r, ys[i] - r, 2 * r, 2 * r);
              } else {
                ctx.moveTo(xs[i] + r, ys[i]);
                ctx.arc(xs[i], ys[i], ring ? r - 1 : r, 0, Math.PI * 2);
              }
            }
            if (!any) continue;
            if (ring) {
              ctx.strokeStyle = style;
              ctx.lineWidth = 2;
              ctx.stroke();
            } else {
              ctx.fillStyle = style;
              ctx.fill();
            }
          }
        }
      };
      if (lit) {
        pass(false, 0.25);
        pass(true, 1);
      } else {
        pass(false, 1);
      }
      for (const i of [focus, hovered]) {
        if (i < 0 || Number.isNaN(xs[i])) continue;
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(xs[i], ys[i], radius[i], 0, Math.PI * 2);
        ctx.fillStyle = accent;
        ctx.fill();
      }
    }

    // Labels in screen pixels, so they stay readable at any zoom. They fade
    // in as you zoom, biggest nodes first; the hovered note, its neighbours
    // and the focus always show.
    const zoomAlpha = Math.min(Math.max((k - 0.9) / 0.6, 0), 1);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.font = `11px ${css.fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = token('--foreground');
    const label = (i: number, alpha: number) => {
      if (!labels[i] || Number.isNaN(xs[i]) || outside(i)) return;
      ctx.globalAlpha = alpha;
      const sx = width / 2 + camera.x + xs[i] * k;
      const sy = height / 2 + camera.y + (ys[i] + radius[i]) * k + 3;
      ctx.fillText(labels[i], sx, sy, 160);
    };
    if (zoomAlpha > 0) {
      let drawn = 0;
      for (let r = 0; r < byRadius.length && drawn < MAX_LABELS; r++) {
        const i = byRadius[r];
        if (i === focus || isLit(i) || Number.isNaN(xs[i]) || outside(i))
          continue;
        label(i, lit ? zoomAlpha * 0.25 : zoomAlpha);
        drawn++;
      }
    }
    if (focus >= 0) label(focus, 1);
    if (hovered >= 0) {
      label(hovered, 1);
      for (const id of lit ?? []) label(indexOf.get(id)!, 1);
    }
    ctx.globalAlpha = 1;
  }

  let drag:
    | {
        target: number;
        startX: number;
        startY: number;
        moved: boolean;
        camX: number;
        camY: number;
        version: number;
      }
    | undefined;

  function local(event: PointerEvent | WheelEvent) {
    const rect = canvas!.getBoundingClientRect();
    return { sx: event.clientX - rect.left, sy: event.clientY - rect.top };
  }

  function onPointerDown(event: PointerEvent) {
    if (drag || event.button > 2) return;
    // The middle and right buttons move the view wherever they go down.
    const { sx, sy } = local(event);
    canvas!.setPointerCapture(event.pointerId);
    drag = {
      target: event.button === 0 ? nodeAt(sx, sy) : -1,
      startX: sx,
      startY: sy,
      moved: false,
      camX: camera.x,
      camY: camera.y,
      version
    };
  }

  function onPointerMove(event: PointerEvent) {
    const { sx, sy } = local(event);
    if (!drag) {
      const next = nodeAt(sx, sy);
      if (next !== hovered) {
        hovered = next;
        showHover();
        canvas!.style.cursor = next >= 0 ? 'pointer' : 'grab';
        schedule();
      }
      return;
    }
    const dx = sx - drag.startX;
    const dy = sy - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    autoFit = false;
    if (drag.target < 0) {
      camera.x = drag.camX + dx;
      camera.y = drag.camY + dy;
      canvas!.style.cursor = 'grabbing';
      schedule();
    } else {
      const { x, y } = toWorld(sx, sy);
      layout.send({
        type: 'drag',
        version: drag.version,
        index: drag.target,
        x,
        y
      });
    }
  }

  function onPointerUp(event: PointerEvent) {
    if (!drag) return;
    const { target, moved } = drag;
    canvas!.releasePointerCapture(event.pointerId);
    canvas!.style.cursor = hovered >= 0 ? 'pointer' : 'grab';
    if (target >= 0) {
      layout.send({ type: 'release', version: drag.version, index: target });
      if (!moved && drag.version === version)
        onEvent(node.onSelect, ids[target]);
    }
    drag = undefined;
  }

  function onPointerLeave() {
    if (drag || hovered < 0) return;
    hovered = -1;
    showHover();
    schedule();
  }

  function onWheel(event: WheelEvent) {
    event.preventDefault();
    const { sx, sy } = local(event);
    const before = toWorld(sx, sy);
    // A mouse set to scroll by lines reports lines, and a trackpad pinch
    // arrives as a ctrl+wheel with small deltas.
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
    const rate = event.ctrlKey ? 0.01 : 0.002;
    const k = Math.min(Math.max(camera.k * Math.exp(-delta * rate), 0.02), 8);
    autoFit = false;
    camera.k = k;
    camera.x = sx - width / 2 - before.x * k;
    camera.y = sy - height / 2 - before.y * k;
    schedule();
  }
</script>

<div
  bind:clientWidth={width}
  bind:clientHeight={height}
  class="relative min-h-60 flex-1 overflow-hidden"
  role="img"
  aria-label={tUi('graph.label')}
  data-graph-state={linksLoaded ? 'ready' : 'loading'}
  data-graph-nodes={shownNodes}
  data-graph-links={shownLinks}
>
  <canvas
    bind:this={glCanvas}
    class="pointer-events-none absolute inset-0 size-full"
  ></canvas>
  <canvas
    bind:this={canvas}
    class="absolute inset-0 size-full cursor-grab touch-none"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onpointerleave={onPointerLeave}
    onmousedown={(event) => {
      // Or the middle button starts the browser's own scrolling.
      if (event.button === 1) event.preventDefault();
    }}
    oncontextmenu={(event) => event.preventDefault()}
  ></canvas>
  {#if empty}
    <p
      class="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-muted-foreground"
    >
      {tUi('graph.empty')}
    </p>
  {/if}
</div>
