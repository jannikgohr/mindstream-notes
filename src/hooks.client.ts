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
