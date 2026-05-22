/**
 * Reposition tldraw's main toolbar at the top of the freeform canvas,
 * slotted to the right of `.tlui-menu-zone`, with the extras row stacked
 * directly underneath. Activates only on mobile (`isMobile()` true) AND
 * when the host window is at least 580px wide — desktop always falls
 * back to tldraw's stock bottom layout regardless of window size, since
 * stylus reach isn't the driver there. Below the width threshold the
 * top-left corner can't host the toolbar next to the menu chip, so
 * tldraw's default also wins.
 *
 * Why this is TS instead of pure CSS:
 *
 *   1. The horizontal offset must track `.tlui-menu-zone`'s rendered
 *      width. The menu zone is `width: fit-content`, so its size shifts
 *      with the active locale, font scale, and tldraw breakpoint
 *      changes. A fixed `left: 56px` works most of the time but the
 *      toolbar bumps into the menu chip on landscape tablets where the
 *      menu zone grows.
 *
 *   2. The extras row sits *below* the inner row, and the inner row's
 *      rendered height varies with how many tools tldraw is showing
 *      (which changes with viewport width via its own overflow handler).
 *      So the extras' `top` has to track `__inner`'s height live.
 *
 *   3. The mobile gate is UA-based (`isMobile()` reads navigator), which
 *      a pure CSS media query can't see. Touch-laptops with stylus would
 *      otherwise opt into the mobile layout, which isn't the intent.
 *
 * Implementation strategy:
 *
 *   - The host element (the freeform-canvas-host wrapper from the Svelte
 *     shell) carries two CSS variables — `--mtb-left` (left offset for
 *     both rows) and `--mtb-extras-top` (top offset for the extras row)
 *     — plus a `toolbar-top-active` class. The matching rules in
 *     app.css read those variables and only apply when the class is
 *     present.
 *
 *   - We watch three things reactively: (a) the menu zone's size via
 *     ResizeObserver, (b) the inner row's size via ResizeObserver,
 *     and (c) the window's width via the resize event for the >= 580px
 *     gate. Any of the three firing recomputes the variables.
 *
 *   - tldraw mounts its UI elements asynchronously after our wrapper
 *     div renders, so a direct `host.querySelector('.tlui-menu-zone')`
 *     on attach returns null. A MutationObserver on the host's subtree
 *     re-runs the wiring whenever the DOM under us changes, so the
 *     ResizeObservers latch on as soon as the elements exist (and
 *     re-latch if tldraw ever unmounts / remounts them).
 *
 *   - Disposal tears down all three observers, clears the CSS vars, and
 *     drops the `toolbar-top-active` class so a later mount starts from
 *     a clean state.
 */

import { isMobile } from '$lib/platform';

const MIN_WIDTH = 580;
/** Horizontal gap between the menu zone and the relocated toolbar.
 *  Matches tldraw's --tl-space-3-like rhythm without hard-coding the
 *  variable (which isn't always set this deep in the tree). */
const HORIZONTAL_GAP = 8;
/** Vertical gap between the inner toolbar row and the extras row. Zero
 *  is intentional — the extras hangs flush under `__inner` so the two
 *  read as one cohesive piece, with the corner-radius swap in app.css
 *  (rounded bottom on extras instead of rounded top) doing the visual
 *  separation. Pulled out as a named constant so it's obvious this is a
 *  deliberate choice, not an oversight. */
const VERTICAL_GAP = 0;

export interface ToolbarLayoutHandle {
  destroy: () => void;
}

export function attachToolbarLayout(host: HTMLElement): ToolbarLayoutHandle {
  // Cache the UA check once. `isMobile()` reads navigator.userAgent,
  // which doesn't mutate during a session — the user can't switch
  // between an Android device and a desktop mid-edit. Caching avoids
  // re-parsing the UA on every resize event.
  const mobile = isMobile();

  // Desktop path is a no-op: we install no observers and no resize
  // listener, so there's nothing to tear down either. Returning a
  // dummy handle keeps the caller's `.destroy()` safe regardless of
  // which path attached.
  if (!mobile) {
    return { destroy: () => {} };
  }

  let menuObserver: ResizeObserver | null = null;
  let innerObserver: ResizeObserver | null = null;
  let observedMenu: Element | null = null;
  let observedInner: Element | null = null;

  /**
   * Re-bind ResizeObservers to whatever menu zone / inner row is
   * currently in the DOM. Called both initially and from the mutation
   * observer whenever tldraw mounts or replaces its UI. We compare the
   * found nodes against the previously-observed ones so we only
   * disconnect / reconnect when the actual element identity changes,
   * which is the cheap path for the common case of "tldraw added an
   * unrelated descendant".
   */
  function refreshSizeObservers(): void {
    const menu = host.querySelector('.tlui-menu-zone');
    const inner = host.querySelector('.tlui-main-toolbar__inner');

    if (menu !== observedMenu) {
      menuObserver?.disconnect();
      menuObserver = null;
      observedMenu = menu;
      if (menu) {
        menuObserver = new ResizeObserver(updateLayout);
        menuObserver.observe(menu);
      }
    }
    if (inner !== observedInner) {
      innerObserver?.disconnect();
      innerObserver = null;
      observedInner = inner;
      if (inner) {
        innerObserver = new ResizeObserver(updateLayout);
        innerObserver.observe(inner);
      }
    }
  }

  function updateLayout(): void {
    const active = mobile && window.innerWidth >= MIN_WIDTH;
    host.classList.toggle('toolbar-top-active', active);
    if (!active) {
      host.style.removeProperty('--mtb-left');
      host.style.removeProperty('--mtb-extras-top');
      return;
    }
    const menu = host.querySelector<HTMLElement>('.tlui-menu-zone');
    const inner = host.querySelector<HTMLElement>('.tlui-main-toolbar__inner');
    if (menu) {
      const width = menu.getBoundingClientRect().width;
      host.style.setProperty('--mtb-left', `${width + HORIZONTAL_GAP}px`);
    }
    if (inner) {
      const height = inner.getBoundingClientRect().height;
      host.style.setProperty('--mtb-extras-top', `${height + VERTICAL_GAP}px`);
    }
  }

  // tldraw renders its UI asynchronously after we mount the wrapper,
  // and may swap elements in/out as breakpoints change. childList+subtree
  // covers both the initial mount and any later UI shape changes.
  const mountObserver = new MutationObserver(() => {
    refreshSizeObservers();
    updateLayout();
  });
  mountObserver.observe(host, { childList: true, subtree: true });

  const onWindowResize = () => updateLayout();
  window.addEventListener('resize', onWindowResize);

  // First pass — handles the case where tldraw is already mounted at
  // attach time (HMR re-attach, or any future change to mount order).
  refreshSizeObservers();
  updateLayout();

  return {
    destroy() {
      mountObserver.disconnect();
      menuObserver?.disconnect();
      innerObserver?.disconnect();
      window.removeEventListener('resize', onWindowResize);
      host.style.removeProperty('--mtb-left');
      host.style.removeProperty('--mtb-extras-top');
      host.classList.remove('toolbar-top-active');
      observedMenu = null;
      observedInner = null;
    }
  };
}
