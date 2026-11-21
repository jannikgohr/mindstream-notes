<script lang="ts">
  /**
   * The `graph` node of a schema view: notes as a force-directed graph of
   * their links, on a canvas. Drag a note to move it, drag the background (or
   * anywhere with the middle or right button) to pan, scroll to zoom, click
   * a note to send `onSelect`.
   *
   * A finger has no hover, so a tap picks a note, which lights its links as
   * hover does and offers to open it. One finger pans, two zoom, and a note
   * moves once the finger has rested on it.
   *
   * The layout runs in a worker (see graph-layout.worker.ts); this side only draws: links and
   * nodes with WebGL (see graph-renderer.ts), labels on a 2D canvas above.
   * Without WebGL the 2D canvas draws everything.
   */
  import { untrack } from 'svelte';
  import { Play, Settings2 } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { loadNoteLinks } from '$lib/notes/note-relations';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { tree } from '$lib/stores/tree.svelte';
  import {
    DEFAULT_FORCES,
    startLayoutWorker,
    type LayoutPositions
  } from './graph-layout';
  import {
    createGraphRenderer,
    NODE_ACCENT,
    NODE_LIT,
    NODE_RING,
    PALETTE_SIZE,
    rgba,
    type GraphRenderer
  } from './graph-renderer';
  import PluginSettingsPanel from './PluginSettingsPanel.svelte';
  import { indexGraph, type GraphIndex } from './schema-graph';
  import { pluginSettingsSectionsFor } from './settings-bridge';
  import type { ViewNode } from './view-schema';

  type GraphNode = Extract<ViewNode, { type: 'graph' }>;
  let {
    pluginId,
    node,
    onEvent
  }: {
    /** The plugin whose settings the gear opens. */
    pluginId: string;
    node: GraphNode;
    onEvent: (event: string, value: string) => void;
  } = $props();

  const hasSettings = $derived(pluginSettingsSectionsFor(pluginId).length > 0);
  let settingsOpen = $state(false);

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
  // How a note stands to the hovered or focused one: 1 that one links to it,
  // 2 it links to that one, 3 both. Each has a colour of GROUP_COLOURS, and
  // 0 is everything else linked, a tag for one.
  const RELATION_COLOURS = [-1, 4, 2, 3];
  const RELATION_LABELS = [
    '',
    'graph.linksTo',
    'graph.linkedFrom',
    'graph.linkedBoth'
  ] as const;
  const DRAG_THRESHOLD = 4;
  // How far around a note a finger still hits it, and how long it must rest
  // on the note before a drag moves the note rather than the view.
  const TOUCH_SLOP = 16;
  const HOLD_MS = 350;
  // Phones report three and more; past two the extra pixels only cost.
  const MAX_PIXEL_RATIO = 2;
  // A new graph of the whole vault grows into place, oldest note first.
  const growMs = (nodes: number) => Math.min(Math.max(nodes * 40, 800), 6000);
  const stillLife =
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
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
  // The note a tap picked, as the bar at the bottom shows it.
  let picked = $state<{ id: string; label: string } | null>(null);

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
  // Node i is linked to adjacent[offset[i]] up to offset[i + 1], and
  // linksAmong[k] of `pairs` lie among the first k nodes.
  let offset = new Uint32Array(1);
  let adjacent = new Uint32Array(0);
  let linksAmong = new Uint32Array(1);
  // How many nodes, from the first, a growing layout has let in so far.
  let active = 0;
  // Which nodes are linked to the hovered one.
  let litNode = new Uint8Array(0);
  let forces = DEFAULT_FORCES;
  let version = 0;
  let hovered = -1;
  let related = new Uint8Array(0);
  // The hovered note's links as index pairs, by the relation of the other end.
  let litLinks: number[][] = [[], [], [], []];
  let legend = $state(false);
  let sentForces = '';
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
    const styles = new Uint8Array(ids.length * 2);
    for (let i = 0; i < ids.length; i++) {
      styles[2 * i] = related[i]
        ? RELATION_COLOURS[related[i]]
        : colour[i] === MUTED
          ? PALETTE_SIZE - 2
          : colour[i];
      styles[2 * i + 1] =
        (other[i] ? NODE_RING : 0) |
        (litNode[i] ? NODE_LIT : 0) |
        (i === focus || i === hovered ? NODE_ACCENT : 0);
    }
    return styles;
  }

  /** How every note stands to the one at `centre`: see RELATION_COLOURS. */
  function relationsTo(centre: number) {
    const relation = new Uint8Array(ids.length);
    if (!node.directions || centre < 0) return relation;
    const id = ids[centre];
    for (const target of outgoing.get(id) ?? []) {
      const i = indexOf.get(target);
      if (i !== undefined && i !== centre) relation[i] |= 1;
    }
    for (let e = offset[centre]; e < offset[centre + 1]; e++) {
      const near = adjacent[e];
      if (outgoing.get(ids[near])?.includes(id)) relation[near] |= 2;
    }
    return relation;
  }

  /** Work out what the hovered note lights up, and tell the renderer. */
  function showHover() {
    const focus =
      node.focus === undefined ? -1 : (indexOf.get(node.focus) ?? -1);
    related = relationsTo(hovered >= 0 ? hovered : focus);
    legend = related.some((relation) => relation > 0);
    litLinks = [[], [], [], []];
    litNode = new Uint8Array(ids.length);
    if (hovered >= 0) {
      for (let e = offset[hovered]; e < offset[hovered + 1]; e++) {
        const near = adjacent[e];
        litNode[near] = 1;
        if (near < active) litLinks[related[near]].push(hovered, near);
      }
    }
    if (!renderer || sceneStale) return;
    renderer.setStyles(nodeStyles());
    renderer.setLitLinks(Uint32Array.from(litLinks.flat()));
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
    active = positions.active;
    xs = positions.x;
    ys = positions.y;
    if (renderer) {
      if (sceneStale) {
        showHover();
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
    const [given, links, titles] = [node, outgoing, tree.notesById];
    // Laying out before the links are in would only be thrown away.
    if (!linksLoaded) return;
    untrack(() =>
      relayout(
        indexGraph(given, links, (id) => Date.parse(titles[id]?.created ?? '')),
        titles
      )
    );
  });

  function relayout(graph: GraphIndex, titles: typeof tree.notesById) {
    const previous = indexOf;
    const [oldX, oldY] = [xs, ys];
    const n = graph.nodes.length;
    const nextIds = graph.nodes.map((g) => g.id);
    const nextIndex = new Map(nextIds.map((id, i) => [id, i]));
    const nextPairs = graph.pairs;
    labels = graph.nodes.map((g) => g.label ?? titles[g.id]?.title ?? '');
    // Most redraws come from an edit that changed no link: keep the layout.
    const same =
      nextIds.length === ids.length &&
      nextIds.every((id, i) => id === ids[i]) &&
      nextPairs.length === pairs.length &&
      nextPairs.every((v, i) => v === pairs[i]);
    forces = {
      centre: node.forces?.centre ?? DEFAULT_FORCES.centre,
      repel: node.forces?.repel ?? DEFAULT_FORCES.repel,
      link: node.forces?.link ?? DEFAULT_FORCES.link,
      linkDistance: node.forces?.linkDistance ?? DEFAULT_FORCES.linkDistance
    };
    const sameForces = JSON.stringify(forces) === sentForces;
    sentForces = JSON.stringify(forces);
    if (same && sameForces && node.focus === fittedFocus) {
      showHover();
      schedule();
      return;
    }
    ({ offset, adjacent, linksAmong } = graph);

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
      (_, i) => 3 + Math.min(Math.sqrt(offset[i + 1] - offset[i]) * 1.5, 9)
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
      for (let e = offset[i]; e < offset[i + 1]; e++) {
        const j = previous.get(ids[adjacent[e]]);
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
    related = new Uint8Array(n);
    litNode = new Uint8Array(n);
    picked = null;
    sceneStale = true;
    empty = n === 0;
    shownNodes = n;
    shownLinks = graph.pairs.length / 2;
    if (kept === 0 || node.focus !== fittedFocus) autoFit = true;

    const grows = kept === 0 && node.focus === undefined && !stillLife;
    if (grows) return replay();
    active = n;
    version++;
    layout.send({
      type: 'layout',
      version,
      radius: radius.slice(),
      x: xs.slice(),
      y: ys.slice(),
      links: pairs.slice(),
      alpha: kept === 0 ? 1 : kept < n || !sameForces ? 0.5 : 0.1,
      warmup: kept === 0,
      forces
    });
    schedule();
  }

  /** Lay the graph out from nothing, a node at a time. */
  function replay() {
    const n = ids.length;
    xs = new Float32Array(n).fill(NaN);
    ys = new Float32Array(n).fill(NaN);
    active = 0;
    autoFit = true;
    picked = null;
    hover(-1);
    version++;
    layout.send({
      type: 'layout',
      version,
      radius: radius.slice(),
      x: xs.slice(),
      y: ys.slice(),
      links: pairs.slice(),
      alpha: 1,
      warmup: false,
      forces,
      grow: growMs(n)
    });
    schedule();
  }

  /** Zoom and centre on every node, at most to twice the natural size. */
  function fit() {
    if (!autoFit || !width || !height || !ids.length) return;
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < active; i++) {
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
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
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

  /** The node at a point, or the nearest within `slop` screen pixels. */
  function nodeAt(sx: number, sy: number, slop = 4): number {
    const { x, y } = toWorld(sx, sy);
    let best = -1;
    let bestGap = Infinity;
    for (let i = active - 1; i >= 0; i--) {
      const gap = Math.hypot(xs[i] - x, ys[i] - y) - radius[i];
      if (gap <= 0) return i;
      if (gap < bestGap) [best, bestGap] = [i, gap];
    }
    return bestGap <= slop / camera.k ? best : -1;
  }

  function hover(next: number) {
    if (next === hovered) return;
    hovered = next;
    showHover();
    schedule();
  }

  function pick(index: number) {
    hover(index);
    picked = index < 0 ? null : { id: ids[index], label: labels[index] };
  }

  function openPicked() {
    if (!picked) return;
    const { id } = picked;
    pick(-1);
    onEvent(node.onSelect, id);
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
        nodes: active,
        linkEnds: 2 * linksAmong[active],
        palette,
        link: rgba(token('--border-strong'), linkAlpha),
        litLinks: litLinks.map((run, relation) => ({
          ends: run.length,
          colour: rgba(
            relation ? fills[RELATION_COLOURS[relation]] : accent,
            0.9
          )
        })),
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
      i >= active ||
      !(xs[i] >= left && xs[i] <= right && ys[i] >= top && ys[i] <= bottom);

    const focus =
      node.focus === undefined ? -1 : (indexOf.get(node.focus) ?? -1);
    const lit = hovered >= 0;
    const isLit = (i: number) => i === hovered || litNode[i] === 1;

    if (!renderer) {
      // Links, in one path: one stroke for all of them is what keeps a big
      // graph fast. The hovered note's links go on top in the accent colour.
      ctx.lineWidth = 1 / k;
      ctx.strokeStyle = token('--border-strong');
      ctx.globalAlpha = linkAlpha;
      ctx.beginPath();
      for (let p = 0; p < 2 * linksAmong[active]; p += 2) {
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
        if (hovered >= 0 && (a === hovered || b === hovered)) continue;
        ctx.moveTo(xs[a], ys[a]);
        ctx.lineTo(xs[b], ys[b]);
      }
      ctx.stroke();
      litLinks.forEach((run, relation) => {
        if (!run.length) return;
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = relation ? fills[RELATION_COLOURS[relation]] : accent;
        ctx.beginPath();
        for (let p = 0; p < run.length; p += 2) {
          ctx.moveTo(xs[run[p]], ys[run[p]]);
          ctx.lineTo(xs[run[p + 1]], ys[run[p + 1]]);
        }
        ctx.stroke();
      });

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
      related.forEach((relation, i) => {
        if (!relation || Number.isNaN(xs[i]) || i >= active) return;
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(xs[i], ys[i], radius[i], 0, Math.PI * 2);
        ctx.fillStyle = fills[RELATION_COLOURS[relation]];
        ctx.fill();
      });
      for (const i of [focus, hovered]) {
        if (i < 0 || i >= active || Number.isNaN(xs[i])) continue;
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
      for (let e = offset[hovered]; e < offset[hovered + 1]; e++)
        label(adjacent[e], 1);
    }
    ctx.globalAlpha = 1;
  }

  // Fingers on the canvas, and the two-finger gesture's last reading.
  let touches: { id: number; sx: number; sy: number }[] = [];
  let pinch: { gap: number; sx: number; sy: number } | undefined;

  function pinchReading() {
    const [a, b] = touches;
    return {
      gap: Math.max(Math.hypot(a.sx - b.sx, a.sy - b.sy), 1),
      sx: (a.sx + b.sx) / 2,
      sy: (a.sy + b.sy) / 2
    };
  }

  function zoomAt(sx: number, sy: number, k: number) {
    const before = toWorld(sx, sy);
    camera.k = Math.min(Math.max(k, 0.02), 8);
    camera.x = sx - width / 2 - before.x * camera.k;
    camera.y = sy - height / 2 - before.y * camera.k;
  }

  function endDrag() {
    if (!drag) return;
    if (drag.target >= 0)
      layout.send({
        type: 'release',
        version: drag.version,
        index: drag.target
      });
    drag = undefined;
  }

  let drag:
    | {
        touch: boolean;
        at: number;
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
    const { sx, sy } = local(event);
    const touch = event.pointerType === 'touch';
    if (touch) {
      touches.push({ id: event.pointerId, sx, sy });
      canvas!.setPointerCapture(event.pointerId);
      if (touches.length === 2) {
        endDrag();
        pinch = pinchReading();
        autoFit = false;
      }
      if (touches.length > 1) return;
    }
    if (drag || event.button > 2) return;
    // The middle and right buttons move the view wherever they go down.
    canvas!.setPointerCapture(event.pointerId);
    drag = {
      touch,
      at: performance.now(),
      target:
        event.button === 0
          ? nodeAt(sx, sy, touch ? TOUCH_SLOP : undefined)
          : -1,
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
    const finger = touches.find((touch) => touch.id === event.pointerId);
    if (finger) Object.assign(finger, { sx, sy });
    if (pinch && touches.length === 2) {
      const next = pinchReading();
      camera.x += next.sx - pinch.sx;
      camera.y += next.sy - pinch.sy;
      zoomAt(next.sx, next.sy, (camera.k * next.gap) / pinch.gap);
      pinch = next;
      schedule();
      return;
    }
    if (!drag) {
      if (event.pointerType === 'touch') return;
      const next = nodeAt(sx, sy);
      canvas!.style.cursor = next >= 0 ? 'pointer' : 'grab';
      hover(next);
      return;
    }
    const dx = sx - drag.startX;
    const dy = sy - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    // A finger that moves off at once is moving the view, not the note.
    if (
      !drag.moved &&
      drag.touch &&
      drag.target >= 0 &&
      performance.now() - drag.at < HOLD_MS
    )
      drag.target = -1;
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
    // A finger left over from a pinch carries nothing on: the view would
    // jump to it.
    const fingers = touches.length;
    touches = touches.filter((touch) => touch.id !== event.pointerId);
    if (touches.length < fingers && pinch) {
      if (touches.length === 0) pinch = undefined;
      return;
    }
    if (!drag) return;
    const { target, moved, touch } = drag;
    const current = drag.version === version;
    canvas!.releasePointerCapture(event.pointerId);
    canvas!.style.cursor = hovered >= 0 ? 'pointer' : 'grab';
    endDrag();
    if (moved || !current || event.type === 'pointercancel') return;
    if (touch) pick(target);
    else if (target >= 0) onEvent(node.onSelect, ids[target]);
  }

  function onPointerLeave(event: PointerEvent) {
    // A lifted finger leaves too, and what it picked stays picked.
    if (drag || event.pointerType === 'touch') return;
    hover(-1);
  }

  function onWheel(event: WheelEvent) {
    event.preventDefault();
    const { sx, sy } = local(event);
    // A mouse set to scroll by lines reports lines, and a trackpad pinch
    // arrives as a ctrl+wheel with small deltas.
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
    const rate = event.ctrlKey ? 0.01 : 0.002;
    autoFit = false;
    zoomAt(sx, sy, camera.k * Math.exp(-delta * rate));
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
  {#if legend}
    <ul
      class="pointer-events-none absolute left-2 top-2 flex flex-col gap-0.5 text-[11px] text-muted-foreground"
    >
      {#each [1, 2, 3] as relation (relation)}
        <li class="flex items-center gap-1.5">
          <span
            class="size-2 rounded-full"
            style="background: var(--named-{GROUP_COLOURS[
              RELATION_COLOURS[relation]
            ]})"
          ></span>
          {tUi(RELATION_LABELS[relation])}
        </li>
      {/each}
    </ul>
  {/if}
  {#if !empty}
    <Button
      variant="ghost"
      size="icon"
      class="absolute top-1 size-8 text-muted-foreground {hasSettings
        ? 'right-9'
        : 'right-1'}"
      title={tUi('graph.replay')}
      aria-label={tUi('graph.replay')}
      onclick={replay}
    >
      <Play class="size-4" />
    </Button>
  {/if}
  {#if hasSettings}
    <Button
      variant="ghost"
      size="icon"
      class="absolute right-1 top-1 size-8 text-muted-foreground"
      title={tUi('graph.settings')}
      aria-label={tUi('graph.settings')}
      aria-expanded={settingsOpen}
      onclick={() => (settingsOpen = !settingsOpen)}
    >
      <Settings2 class="size-4" />
    </Button>
    {#if settingsOpen}
      <div
        class="themed-scrollbar absolute right-1 top-10 max-h-[calc(100%-2.75rem)] w-72 max-w-[calc(100%-0.5rem)] overflow-y-auto rounded-lg border border-border bg-surface-1 p-3 shadow-overlay"
      >
        <PluginSettingsPanel {pluginId} />
      </div>
    {/if}
  {/if}
  {#if picked}
    <div
      class="absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-lg border border-border bg-surface-1 py-1.5 pl-3 pr-1.5 shadow-overlay"
    >
      <span class="min-w-0 flex-1 truncate text-sm">{picked.label}</span>
      <Button size="sm" onclick={openPicked}>{tUi('graph.open')}</Button>
    </div>
  {/if}
  {#if empty}
    <p
      class="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-muted-foreground"
    >
      {tUi('graph.empty')}
    </p>
  {/if}
</div>
