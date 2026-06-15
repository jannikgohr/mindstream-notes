/**
 * Chrome-style tab drag visual for dockview's HTML5 (mouse) drag engine.
 *
 * Why HTML5 and not the pointer engine: dockview only commits smooth
 * cross-group "drop between two tabs" via its HTML5 tab-strip drop handler;
 * its pointer engine has no equivalent, so dropping a tab between tabs of
 * another group silently fails there. We therefore stay on the default
 * (HTML5-for-mouse) engine — but HTML5's native drag image can't be
 * repositioned mid-drag, so we render our own.
 *
 * Approach:
 *   1. Blank dockview's native drag image (a transparent `setDragImage`).
 *      This only affects mouse drags — touch uses dockview's own pointer
 *      ghost and fires no `dragstart`, so it's left untouched.
 *   2. Render our own clone of the tab and position it every `dragover`:
 *        - over a tab strip → seated in the strip's vertical band (X follows
 *          the cursor), so the tab looks like it's in the bar;
 *        - elsewhere → the grab point stays under the cursor.
 *
 * The ghost is appended to <body> and positioned with a *self-correcting*
 * transform: we measure where `translate=0` actually lands (its containing
 * block's origin) and offset by the delta, so it hits the intended viewport
 * point even if an ancestor establishes a containing block.
 */

const STRIP_SELECTOR = '.dv-tabs-and-actions-container';

let installed = false;
let ghost: HTMLElement | null = null;
// Cursor position within the grabbed tab's border box, captured at dragstart.
let grabX = 0;
let grabY = 0;

// 1×1 transparent GIF used to blank the native drag image. Created once so
// it's decoded before the first drag.
const TRANSPARENT_DRAG_IMAGE: HTMLImageElement | null =
  typeof Image === 'undefined'
    ? null
    : Object.assign(new Image(), {
        src: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
      });

function buildGhost(tab: HTMLElement): HTMLElement {
  const clone = tab.cloneNode(true) as HTMLElement;
  // Inline the tab's computed styles so the clone keeps its look once it's
  // reparented out of the (scoped) tab strip — same technique dockview uses
  // for its own ghost.
  const computed = getComputedStyle(tab);
  for (const prop of computed) {
    clone.style.setProperty(
      prop,
      computed.getPropertyValue(prop),
      computed.getPropertyPriority(prop)
    );
  }
  // Drop the close (×) affordance from the floating copy.
  clone.querySelector('.dv-default-tab-action')?.remove();
  Object.assign(clone.style, {
    position: 'fixed',
    left: '0px',
    top: '0px',
    margin: '0',
    outline: 'none',
    transition: 'none',
    pointerEvents: 'none',
    zIndex: '99999',
    opacity: '0.9',
    // Read as a lifted card rather than an outline of the (often transparent)
    // inactive tab.
    background: 'var(--background)',
    boxShadow: '0 4px 14px rgb(0 0 0 / 0.25)',
    willChange: 'transform'
  });
  return clone;
}

function position(clientX: number, clientY: number): void {
  if (!ghost) return;

  const desiredLeft = clientX - grabX;
  const strip = document
    .elementFromPoint(clientX, clientY)
    ?.closest<HTMLElement>(STRIP_SELECTOR);
  const desiredTop = strip
    ? (() => {
        const rect = strip.getBoundingClientRect();
        return rect.top + (rect.height - ghost!.offsetHeight) / 2;
      })()
    : clientY - grabY;

  // Self-correct for a transformed containing block: find where translate=0
  // lands (rect minus the current translate) and offset to the desired point.
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

function removeGhost(): void {
  ghost?.remove();
  ghost = null;
}

function onDragStart(event: DragEvent): void {
  const tab = (event.target as Element | null)?.closest?.('.dv-tab');
  // Only dockview header tabs (those live inside a tabs container) — not the
  // overflow-popup tab list, etc.
  if (!(tab instanceof HTMLElement) || !tab.closest('.dv-tabs-container')) {
    return;
  }
  // Blank the native drag image. We listen at document level (bubble), so this
  // runs after dockview's own tab-element setDragImage and wins.
  if (event.dataTransfer && TRANSPARENT_DRAG_IMAGE) {
    event.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMAGE, 0, 0);
  }
  // Capture the grab offset now, before smooth mode collapses the source tab.
  const rect = tab.getBoundingClientRect();
  grabX = event.clientX - rect.left;
  grabY = event.clientY - rect.top;

  removeGhost();
  ghost = buildGhost(tab);
  document.body.appendChild(ghost);
  position(event.clientX, event.clientY);
}

function onDragOver(event: DragEvent): void {
  if (!ghost) return;
  // The drop/dragend tail can report (0,0); ignore so the ghost doesn't snap
  // to the corner just before teardown.
  if (event.clientX === 0 && event.clientY === 0) return;
  position(event.clientX, event.clientY);
}

/**
 * Register the global drag listeners that render the custom tab drag ghost.
 * Idempotent; call once on dockview setup.
 */
export function ensureTabDragGhost(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('dragstart', onDragStart, false);
  document.addEventListener('dragover', onDragOver, false);
  // Capture so we always clean up even if something stops propagation.
  document.addEventListener('dragend', removeGhost, true);
  document.addEventListener('drop', removeGhost, true);
}
