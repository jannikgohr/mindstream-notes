/**
 * Edge auto-scroll for pointer-driven drags.
 *
 * Near a scroll container's edge a drag is ambiguous: the user may want to
 * drop right there, or scroll on to drop further along. Instead of a binary
 * "inside the edge band, scroll by N px" rule, speed ramps up the closer the
 * pointer gets to the edge, so hovering near it nudges and pushing into it
 * races. Scrolling runs on its own frame loop, so it keeps going while the
 * pointer rests in the band rather than only when it moves.
 */

export const EDGE_SCROLL_ZONE_PX = 48;
export const EDGE_SCROLL_MAX_SPEED_PX_PER_MS = 1.2;

export type EdgeScrollAxis = 'x' | 'y';

/**
 * Signed scroll speed in px/ms for a pointer at `position` on an axis that
 * spans `start`..`end`. Negative scrolls toward `start`. The band shrinks on
 * small containers so the middle third never scrolls.
 */
export function edgeScrollSpeed(
  position: number,
  start: number,
  end: number,
  zone = EDGE_SCROLL_ZONE_PX,
  maxSpeed = EDGE_SCROLL_MAX_SPEED_PX_PER_MS
): number {
  const band = Math.min(zone, (end - start) / 3);
  if (band <= 0) return 0;
  const ramp = (distance: number) => {
    const depth = 1 - Math.max(0, distance) / band;
    return maxSpeed * depth * depth;
  };
  if (position - start < band) return -ramp(position - start);
  if (end - position < band) return ramp(end - position);
  return 0;
}

export interface EdgeAutoScroll {
  /** Feed the latest pointer position; starts scrolling when it is in a band. */
  update(clientX: number, clientY: number): void;
  stop(): void;
}

/**
 * Auto-scroll `element` along `axis` while a drag is in flight. `onScroll`
 * runs after each scrolled frame so the caller can re-hit-test its drop target
 * against content that moved under a still pointer.
 */
export function createEdgeAutoScroll(
  element: HTMLElement,
  axis: EdgeScrollAxis,
  onScroll?: () => void
): EdgeAutoScroll {
  let pointer: { x: number; y: number } | null = null;
  let frame = 0;
  let lastTime = 0;
  // scrollTop/scrollLeft snap to device pixels, so slow speeds accumulate
  // here until they add up to a whole pixel.
  let remainder = 0;

  function speed(): number {
    if (!pointer) return 0;
    const rect = element.getBoundingClientRect();
    return axis === 'y'
      ? edgeScrollSpeed(pointer.y, rect.top, rect.bottom)
      : edgeScrollSpeed(pointer.x, rect.left, rect.right);
  }

  function tick(now: number) {
    frame = 0;
    const velocity = speed();
    if (velocity === 0) return;
    const elapsed = Math.min(32, Math.max(0, now - lastTime));
    lastTime = now;
    remainder += velocity * elapsed;
    const step = Math.trunc(remainder);
    if (step !== 0) {
      remainder -= step;
      const before = axis === 'y' ? element.scrollTop : element.scrollLeft;
      if (axis === 'y') element.scrollTop += step;
      else element.scrollLeft += step;
      const after = axis === 'y' ? element.scrollTop : element.scrollLeft;
      if (after !== before) onScroll?.();
    }
    frame = requestAnimationFrame(tick);
  }

  return {
    update(clientX, clientY) {
      pointer = { x: clientX, y: clientY };
      if (frame || speed() === 0) return;
      lastTime = performance.now();
      remainder = 0;
      frame = requestAnimationFrame(tick);
    },
    stop() {
      pointer = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}
