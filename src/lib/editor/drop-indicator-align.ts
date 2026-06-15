/**
 * Keeps Milkdown's block-drag drop indicator aligned with the cursor.
 *
 * The indicator (from `@milkdown/plugin-cursor`) is a `position: fixed`
 * element whose position is written as `transform: translate(x, y)` using
 * **viewport** coordinates straight from `getBoundingClientRect()`. A fixed
 * element only resolves against the viewport when no ancestor establishes a
 * containing block — but our editor lives inside a Dockview panel, and
 * Dockview puts `transform: translate3d(0,0,0)` on its containers. A
 * transformed ancestor becomes the containing block for `fixed` descendants,
 * so the indicator's origin is the panel's top-left corner, offset from the
 * viewport by the top bar, tab strip, and left sidebar.
 *
 * The previous fix hardcoded that offset in CSS (`top: -40px`, a sidebar-width
 * calc). That broke the moment any chrome changed height — which is exactly the
 * regression this replaces. Instead we measure the indicator's real containing
 * block live (just before each drag, and on resize) and set its `top`/`left`
 * to the negative of that block's viewport rect. The plugin's
 * `translate(viewportX, viewportY)` then lands at true viewport coordinates:
 *
 *     panelOrigin  +  (−panelOrigin)  +  translate(viewportCoords)  =  viewport
 *
 * Self-zeroing: when there is no transformed ancestor (e.g. the fullscreen
 * single-note window, which isn't inside Dockview), no containing block is
 * found and the correction is 0 — which is already correct there.
 *
 * One global, idempotent registration handles every open editor: each drag
 * realigns *all* indicators on the page, each against its own containing
 * block, so two notes side-by-side in Dockview stay independently correct.
 */

let registered = false;

/**
 * CSS properties that make an element the containing block for its
 * `position: fixed` descendants. `transform` is the one Dockview uses;
 * the rest are included so the fix stays correct if the chrome ever
 * starts using filters, containment, etc.
 */
function establishesFixedContainingBlock(style: CSSStyleDeclaration): boolean {
  if (style.transform !== 'none') return true;
  if (style.perspective !== 'none') return true;
  if (style.filter !== 'none') return true;
  // backdropFilter is vendor-prefixed in some engines.
  const backdrop =
    style.backdropFilter ??
    (style as unknown as Record<string, string>)['webkitBackdropFilter'];
  if (backdrop && backdrop !== 'none') return true;
  if (/transform|perspective|filter/.test(style.willChange)) return true;
  if (/(^|\s)(layout|paint|strict|content)(\s|$)/.test(style.contain))
    return true;
  return false;
}

/** Nearest ancestor that fixed descendants are positioned against, or null. */
function findFixedContainingBlock(start: Element | null): Element | null {
  let el = start;
  while (el && el !== document.documentElement) {
    if (establishesFixedContainingBlock(getComputedStyle(el))) return el;
    el = el.parentElement;
  }
  return null;
}

function realignAllIndicators(): void {
  const indicators = document.querySelectorAll<HTMLElement>(
    '.milkdown-drop-indicator'
  );
  for (const dom of indicators) {
    const block = findFixedContainingBlock(dom.parentElement);
    if (block) {
      const rect = block.getBoundingClientRect();
      dom.style.left = `${-rect.left}px`;
      dom.style.top = `${-rect.top}px`;
    } else {
      // No transformed ancestor → fixed resolves to the viewport already.
      dom.style.left = '0px';
      dom.style.top = '0px';
    }
  }
}

/**
 * Register the global listeners that keep every drop indicator aligned.
 * Idempotent — safe to call from each editor's onMount. Listeners live for
 * the app's lifetime; there is at most one indicator-bearing editor type and
 * the handlers are cheap (they run only on drag start and resize).
 */
export function ensureDropIndicatorAlignment(): void {
  if (registered || typeof document === 'undefined') return;
  registered = true;
  // Capture phase so we measure before the drag's first `dragover` paints the
  // indicator. The block handle's drag is native HTML5 DnD, so `dragstart`
  // fires once at grab time.
  document.addEventListener('dragstart', realignAllIndicators, true);
  // A resize can move the panel (and thus the containing block) mid-drag.
  window.addEventListener('resize', realignAllIndicators);
}
