/**
 * Reactive "is Split on offer right now?".
 *
 * Split is gated on viewport width (see `SPLIT_MIN_WIDTH`), and that answer has
 * to change live: rotating a tablet or resizing a window moves the device
 * across the threshold while notes are open and the settings dialog is up.
 *
 * Deliberately NOT `innerWidth` from `svelte/reactivity/window`, which does
 * exactly this and more. That module also constructs its `devicePixelRatio`
 * singleton eagerly, and its constructor runs
 * `window.matchMedia(…).addEventListener('change', …)` at IMPORT time. This
 * module is reachable from the settings registry, hence from `settings/store`,
 * hence from most of the app — so that subscription would be installed for
 * every consumer, and it broke `reduce-motion.svelte.test.ts`, which stubs
 * `matchMedia` and captures listeners by registration order. One passive
 * resize listener is all this needs and costs nothing at import on the server.
 *
 * The threshold logic itself stays pure (and unit-tested) in `./view-mode`;
 * this file only supplies the live width.
 */

import { splitFitsWidth } from './view-mode';

/**
 * Wrapped in an object rather than a bare `$state` export: a reassigned
 * module-level `let` wouldn't propagate to importers, whereas a mutated
 * property on a shared object does.
 *
 * `undefined` off-browser (SSR / prerender) — `splitFitsWidth` treats that as
 * available so the option doesn't flicker in on hydration.
 */
const viewport = $state<{ width: number | undefined }>({
  width: typeof window === 'undefined' ? undefined : window.innerWidth
});

if (typeof window !== 'undefined') {
  // Module-scope and never removed: the value is app-lifetime, one listener is
  // shared by every reader, and there is no teardown point that isn't just
  // process exit.
  window.addEventListener(
    'resize',
    () => {
      viewport.width = window.innerWidth;
    },
    { passive: true }
  );
}

/** Call inside a reactive context (`$derived`/`$effect`) to track the width. */
export function splitAvailable(): boolean {
  return splitFitsWidth(viewport.width);
}
