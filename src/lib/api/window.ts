/**
 * Window-management bridge. Popouts are spawned from the frontend via
 * Tauri's WebviewWindow constructor — keeping it on this side avoids a
 * Rust round-trip and lets the +page.svelte route read the window label
 * directly to decide what to render.
 */

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isTauri } from './index';

export async function openNoteWindow(id: string, title: string): Promise<void> {
  // Browser fallback (`pnpm dev` outside Tauri): just open a tab with
  // the id encoded in the URL — keeps the UX clickable in dev.
  if (!isTauri()) {
    if (typeof window !== 'undefined') {
      window.open(
        `?window=editor&id=${encodeURIComponent(id)}`,
        '_blank',
        'noopener'
      );
    }
    return;
  }

  const win = new WebviewWindow(id, {
    title,
    width: 900,
    height: 700,
    minWidth: 560,
    minHeight: 420,
    center: true,
    resizable: true,
    decorations: true,
    // Critical for HTML5 DnD inside the popout: Tauri's file-drop handler
    // is ON by default, which on Windows (and in some WebKit2 builds) eats
    // the dragstart events that Milkdown / our file-tree DnD rely on.
    // The main window has the same flag in tauri.conf.json — popouts must
    // mirror it explicitly because they don't inherit the parent's config.
    dragDropEnabled: false
  });

  // Surface failures so future regressions show up in the console instead
  // of silently producing a half-broken window.
  win.once('tauri://error', (e) => {
    console.error('[openNoteWindow] failed to spawn', id, e);
  }).then();
}
