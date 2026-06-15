/**
 * Chrome-style tab drag positioning for the pointer drag engine.
 *
 * Dockview's `dndStrategy: 'pointer'` renders the drag visual as a DOM clone
 * (`.dv-tab-ghost-drag`, positioned via `transform` each pointermove) rather
 * than the native HTML5 drag image — so we can place it ourselves. We take
 * over both axes for the duration of a tab drag:
 *
 *   - Over a tab strip  → the ghost is pinned to the strip's vertical band so
 *     it looks seated in the row (X follows the cursor).
 *   - Anywhere else     → the ghost sits under the cursor at the point the tab
 *     was grabbed (both axes follow), so it appears exactly where the cursor
 *     is — not at dockview's baked `clientY + 10` offset.
 *
 * Why we don't read the ghost's position back: the ghost is a clone that
 * inlines the tab's `margin`, so `getBoundingClientRect().left` is offset from
 * its `translateX` by that margin. Feeding that back into `translateX` each
 * frame re-adds the margin and the ghost creeps sideways while the pointer is
 * still. Instead we derive the transform purely from the cursor and a grab
 * offset captured at `pointerdown` (before smooth mode collapses the source
 * tab, which would zero its width). `.dv-tab-ghost-drag` also gets `margin: 0`
 * in app.css so the captured offset lands exactly.
 *
 * Why a rAF loop rather than a pointermove handler: dockview writes the ghost
 * transform inside its own (non-exported) pointermove handler, and we can't
 * reliably order a DOM listener after it. rAF runs after the frame's
 * pointermoves and before paint, so our transform is the one that paints — no
 * flicker, no ordering dependency.
 */

const GHOST_SELECTOR = '.dv-tab-ghost-drag';
// The whole header band (tabs list + void space + actions), so the seat holds
// across the entire strip the way Chrome keeps a tab in the bar.
const STRIP_SELECTOR = '.dv-tabs-and-actions-container';

let installed = false;
let active = false;
let rafId: number | null = null;
let lastX = 0;
let lastY = 0;
// Cursor position within the grabbed tab's border box, captured at
// pointerdown. Drives where the ghost sits relative to the cursor.
let grabX = 0;
let grabY = 0;

function onPointerDownCapture(e: PointerEvent): void {
  const tab = (e.target as Element | null)?.closest?.('.dv-tab');
  if (!tab) return;
  const rect = tab.getBoundingClientRect();
  grabX = e.clientX - rect.left;
  grabY = e.clientY - rect.top;
  lastX = e.clientX;
  lastY = e.clientY;
}

function trackMove(e: PointerEvent): void {
  lastX = e.clientX;
  lastY = e.clientY;
}

function frame(): void {
  if (!active) {
    rafId = null;
    return;
  }
  rafId = requestAnimationFrame(frame);

  const ghost = document.querySelector<HTMLElement>(GHOST_SELECTOR);
  if (!ghost) return; // ghost not built yet, or this drag has no tab ghost

  // Desired *viewport* position of the ghost's top-left corner.
  const desiredLeft = lastX - grabX;

  // The ghost has `pointer-events: none`, so elementFromPoint returns the real
  // chrome beneath the cursor.
  const strip = document
    .elementFromPoint(lastX, lastY)
    ?.closest<HTMLElement>(STRIP_SELECTOR);

  let desiredTop: number;
  if (strip) {
    // Seat the ghost like a real tab: vertically centred in the strip band.
    const stripRect = strip.getBoundingClientRect();
    desiredTop = stripRect.top + (stripRect.height - ghost.offsetHeight) / 2;
  } else {
    // Free-float: keep the grab point under the cursor.
    desiredTop = lastY - grabY;
  }

  // The ghost is `position: fixed`, but dockview mounts it where it ends up in
  // a transformed containing block (the panel/grid transforms), so a plain
  // translate(viewportCoords) lands offset by that ancestor — the cause of the
  // "ghost floats half a screen below the cursor" bug. Rather than assume the
  // viewport is the origin, measure it: read the live box and the transform
  // currently applied, derive where translate=0 actually lands (the containing
  // block's viewport origin), and translate by the delta to the desired point.
  // Robust regardless of where/whether dockview transforms the ghost's parent.
  const rect = ghost.getBoundingClientRect();
  const transform = getComputedStyle(ghost).transform;
  const current =
    transform && transform !== 'none'
      ? new DOMMatrixReadOnly(transform)
      : new DOMMatrixReadOnly();
  const originLeft = rect.left - current.m41;
  const originTop = rect.top - current.m42;

  const tx = Math.round(desiredLeft - originLeft);
  const ty = Math.round(desiredTop - originTop);
  ghost.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
}

/**
 * Install the persistent `pointerdown` listener that captures the grab offset.
 * Must run before any drag starts (the offset has to be read before smooth
 * mode collapses the source tab). Idempotent; call once on dockview setup.
 */
export function ensureTabDragPin(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('pointerdown', onPointerDownCapture, {
    capture: true,
    passive: true
  });
}

/**
 * Begin driving the ghost position for an in-flight pointer drag. Idempotent.
 * Wire to dockview's `onWillDragPanel` / `onWillDragGroup`.
 */
export function startTabDragPin(): void {
  if (active || typeof window === 'undefined') return;
  active = true;
  window.addEventListener('pointermove', trackMove, {
    passive: true,
    capture: true
  });
  rafId = requestAnimationFrame(frame);
}

/**
 * Stop driving the ghost. Idempotent and safe to call on every
 * pointerup/cancel (pointer drags emit no DOM `dragend`).
 */
export function stopTabDragPin(): void {
  if (!active) return;
  active = false;
  window.removeEventListener('pointermove', trackMove, true);
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}
