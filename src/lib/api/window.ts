/**
 * Window-management bridge. Popouts are spawned from the frontend via
 * Tauri's WebviewWindow constructor — keeping it on this side avoids a
 * Rust round-trip and lets the +page.svelte route read the window label
 * directly to decide what to render.
 */

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isTauri } from './core';
import { getCustomWindowDecorations } from './desktop-settings';
import {
  type DockviewApi,
  type IDockviewGroupPanel,
  type IDockviewPanel
} from 'dockview-core';

/**
 * Pick a WebView background colour matching the saved (or OS-default) theme
 * so the popout doesn't flash white before app.css loads. Mirrors the logic
 * in app.html's pre-paint theme script.
 */
function themedWindowBackground(): {
  red: number;
  green: number;
  blue: number;
  alpha: number;
} {
  let useDark = false;
  try {
    const stored = localStorage.getItem('mode-watcher-mode');
    const prefersDark =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    useDark = stored === 'dark' || (stored !== 'light' && prefersDark);
  } catch {
    /* localStorage may be unavailable in some contexts; fall back to light. */
  }
  return useDark
    ? { red: 10, green: 10, blue: 10, alpha: 255 }
    : { red: 255, green: 255, blue: 255, alpha: 255 };
}

/**
 * Note popout windows use the note id as their Tauri label. When one is
 * already alive, bring that window forward instead of opening a second editor
 * for the same note.
 */
export async function focusExistingNoteWindow(id: string): Promise<boolean> {
  if (!isTauri()) return false;

  try {
    const win = await WebviewWindow.getByLabel(id);
    if (!win) return false;

    if (await win.isMinimized()) {
      await win.unminimize();
    }
    await win.setFocus();
    return true;
  } catch (err) {
    console.warn('[focusExistingNoteWindow] failed', id, err);
    return false;
  }
}

export async function focusMainWindow(): Promise<void> {
  if (!isTauri()) return;

  try {
    const win = await WebviewWindow.getByLabel('main');
    if (!win) return;
    if (await win.isMinimized()) {
      await win.unminimize();
    }
    await win.show();
    await win.setFocus();
  } catch (err) {
    console.warn('[focusMainWindow] failed', err);
  }
}

/**
 * Spawn a Tauri window for a single note.
 *
 * `panelGroup` and `dock` are optional context for the "pop out" flow:
 * when invoked from a dock tab, we remove the source tab so the note
 * isn't open in two places at once. Pass `null` for both when there's
 * no source dock (e.g. the "Open in new window" item in the file tree).
 */
export async function openNoteWindow(
  id: string,
  title: string,
  panelGroup: IDockviewGroupPanel | null,
  dock: DockviewApi | null
): Promise<void> {
  if (await focusExistingNoteWindow(id)) return;

  // Browser fallback (`pnpm dev` outside Tauri): just open a tab with the
  // id encoded in the URL — keeps the UX clickable without Tauri.
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

  const customWindowDecorations = await getCustomWindowDecorations();
  const win = new WebviewWindow(id, {
    title,
    width: 900,
    height: 700,
    minWidth: 560,
    minHeight: 420,
    center: true,
    resizable: true,
    decorations: !customWindowDecorations,
    dragDropEnabled: false,
    // Match the active theme so the popout's first paint isn't a white flash.
    backgroundColor: themedWindowBackground()
  });

  // Surface failures so future regressions show up in the console instead
  // of silently producing a half-broken window.
  win
    .once('tauri://error', (e) => {
      console.error('[openNoteWindow] failed to spawn', id, e);
    })
    .then();

  if (panelGroup) {
    const activePanel: IDockviewPanel | undefined = panelGroup?.activePanel;

    if (!activePanel || !dock) {
      console.error(
        '[openNoteWindow] failed to spawn because activePanel or dockApi was null',
        id,
        activePanel,
        dock
      );
      return;
    }

    // 1. Snapshot the panel state before it vanishes
    const panelConfig = {
      id: activePanel.id,
      component: activePanel.api.component,
      params: { ...activePanel.params },
      title: activePanel.title
    };

    const originalGroupId = panelGroup.id;

    // 2. Close the original panel once the window is ready
    await win.once('tauri://webview-created', () => {
      dock.removePanel(activePanel);
    });

    // 3. Re-open the panel when the popout window is closed
    await win.once('tauri://close-requested', async () => {
      console.info('[openNoteWindow] close requested');
      // Check if the group still exists, otherwise it defaults to a sensible location
      const targetGroup = dock.getGroup(originalGroupId);

      dock.addPanel({
        id: panelConfig.id,
        component: panelConfig.component,
        params: panelConfig.params,
        title: panelConfig.title,
        ...(targetGroup
          ? { position: { referenceGroup: originalGroupId } }
          : {})
      });

      // Close the Tauri window
      await win.close();
    });
  }
}
