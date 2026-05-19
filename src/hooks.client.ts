import type { Reroute } from '@sveltejs/kit';

/**
 * Tauri opens spawned WebviewWindows by file path (e.g. `index.html?...`).
 * Without intervention SvelteKit's router sees pathname `/index.html`,
 * doesn't match our root `+page.svelte`, and renders nothing — the new
 * window stays blank, the webview becomes unresponsive, and the OS-level
 * close button stops working. Rewriting the path here makes those URLs
 * land on `/` while preserving the query string and hash automatically.
 */
export const reroute: Reroute = ({ url }) => {
  if (url.pathname === '/index.html' || url.pathname === '/index.html/') {
    return '/';
  }
  return undefined;
};

/**
 * Publish the visual viewport height as a CSS custom property so the
 * root layout can size itself to the *visible* area, not the underlying
 * window. Edge-to-edge Android keeps the WebView at full window height
 * when the soft keyboard opens, so without this the layout viewport
 * stays oversized and Chromium scrolls the document body to keep the
 * focused contenteditable in view — which slides the MobileEditor's
 * back-button header off the top. Driving the root off --app-h instead
 * means the flex chain reflows shorter and no scroll is needed.
 *
 * Also clears any scrollTop that the browser may have applied to the
 * document before our resize callback ran — `overflow: hidden` blocks
 * user-initiated scrolling but not programmatic scrollIntoView.
 *
 * Guarded on `window` so SvelteKit's prerender pass (where there is no
 * DOM) doesn't blow up, and on `visualViewport` so older WebViews fall
 * through to the `100%` fallback in app.css.
 */
if (typeof window !== 'undefined' && window.visualViewport) {
  const vv = window.visualViewport;
  const sync = () => {
    document.documentElement.style.setProperty('--app-h', `${vv.height}px`);
    if (document.documentElement.scrollTop !== 0) document.documentElement.scrollTop = 0;
    if (document.body.scrollTop !== 0) document.body.scrollTop = 0;
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
}
