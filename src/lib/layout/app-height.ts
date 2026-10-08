/**
 * Visible-viewport tracking for the app shell.
 *
 * Publishes the visual viewport height as the `--app-h` custom property so
 * the root layout can size itself to the *visible* area, not the underlying
 * window. Edge-to-edge Android keeps the WebView at full window height when
 * the soft keyboard opens, so without this the layout viewport stays
 * oversized and Chromium scrolls the document body to keep the focused
 * contenteditable in view — which slides the MobileEditor's back-button
 * header off the top. Driving the root off `--app-h` instead means the flex
 * chain reflows shorter and no scroll is needed.
 *
 * That reflow is right for the editor, whose content has to stay above the
 * keyboard. It is wrong for a bottom sheet with a text field: the sheet is
 * `position: fixed`, so it does not follow the shrinking root, while the
 * screen behind its scrim visibly rearranges (the bottom nav jumps up above
 * the keyboard). Such a sheet takes a hold, which keeps the shell at full
 * height, and anchors itself above the keyboard with `keyboardInset`.
 */

/** How long a released hold waits for the keyboard to finish closing. */
const KEYBOARD_SETTLE_MS = 600;

/**
 * Height of the soft keyboard covering the bottom of the layout viewport, in
 * px. Zero when no keyboard is up or the platform resizes the window instead.
 *
 * Keyboard height = layout viewport height − visual viewport height.
 * `offsetTop` covers Android variants that pan the visual viewport instead of
 * resizing it: what's left is the distance from the layout viewport's bottom
 * edge to the visual viewport's bottom edge, which is where a `position:
 * fixed` element has to sit to rest on top of the keyboard.
 */
export function keyboardInset(win: Window = window): number {
  const vv = win.visualViewport;
  if (!vv) return 0;
  return Math.max(0, win.innerHeight - vv.height - vv.offsetTop);
}

export interface AppHeightController {
  /**
   * Keep the shell at full window height until the returned function is
   * called. Holds nest: the shell follows the keyboard again once the last
   * one is released.
   */
  hold(): () => void;
}

const NO_CONTROLLER: AppHeightController = { hold: () => () => {} };

/**
 * Start publishing `--app-h` for `win`. Returns the inert controller when the
 * WebView has no `visualViewport`; app.css then keeps its `100%` fallback.
 */
export function createAppHeightController(win: Window): AppHeightController {
  const vv = win.visualViewport;
  if (!vv) return NO_CONTROLLER;
  const root = win.document.documentElement;
  let holds = 0;

  const sync = () => {
    // Held: drop the inline value so the `100%` default from app.css applies
    // and the shell spans the whole window, keyboard or not.
    if (holds > 0) root.style.removeProperty('--app-h');
    else root.style.setProperty('--app-h', `${vv.height}px`);
    // Clear any scrollTop the browser applied before this callback ran —
    // `overflow: hidden` blocks user-initiated scrolling but not
    // programmatic scrollIntoView.
    if (root.scrollTop !== 0) root.scrollTop = 0;
    if (win.document.body.scrollTop !== 0) win.document.body.scrollTop = 0;
  };

  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();

  return {
    hold() {
      holds += 1;
      sync();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const finish = () => {
          holds -= 1;
          sync();
        };
        if (keyboardInset(win) === 0) {
          finish();
          return;
        }
        // The keyboard is still up: the sheet's field has only just lost
        // focus and the keyboard is sliding away. Following it now would
        // shrink the shell to the old visible height for a few frames, then
        // grow it back. Wait for the viewport to report the keyboard gone.
        // The timer covers the keyboard that stays, because focus moved to
        // another field.
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          vv.removeEventListener('resize', onResize);
          win.clearTimeout(timer);
          finish();
        };
        const onResize = () => {
          if (keyboardInset(win) === 0) settle();
        };
        vv.addEventListener('resize', onResize);
        const timer = win.setTimeout(settle, KEYBOARD_SETTLE_MS);
      };
    }
  };
}

let installed: AppHeightController | null = null;

/**
 * Install the app-wide controller. Called once from hooks.client.ts; guarded
 * on `window` so SvelteKit's prerender pass (where there is no DOM) doesn't
 * blow up.
 */
export function installAppHeightSync(): void {
  if (installed || typeof window === 'undefined') return;
  installed = createAppHeightController(window);
}

/** Hold the app-wide controller. A no-op before `installAppHeightSync`. */
export function holdAppHeight(): () => void {
  return (installed ?? NO_CONTROLLER).hold();
}
