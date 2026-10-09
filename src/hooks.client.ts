import type { HandleClientError, Reroute } from '@sveltejs/kit';
import { installAppHeightSync } from '$lib/layout/app-height';
import {
  installRuntimeErrorReporting,
  reportRuntimeError
} from '$lib/runtime-errors';

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
 * SvelteKit's optimised client bundle destructures `{ handleError, init }`
 * from this module unconditionally; declaring them — even as no-op
 * pass-throughs — silences the "not exported" rollup warning and gives
 * us a single place to add real client-error reporting later.
 */
export const init = () => {
  installRuntimeErrorReporting();
};

export const handleError: HandleClientError = ({ error }) => {
  reportRuntimeError(error);
};

// Publish the visible viewport height as --app-h so the root layout follows
// the mobile soft keyboard. The why, and the hold that bottom sheets take on
// it, live in $lib/layout/app-height.
installAppHeightSync();
