/**
 * Window-management bridge. Popouts are spawned from the frontend via
 * Tauri's WebviewWindow constructor — keeping it on this side avoids a
 * Rust round-trip and lets the +page.svelte route read the window label
 * directly to decide what to render.
 */

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isTauri } from './core';
import { getCustomWindowDecorations } from './desktop-settings';
import { getWorkerBrowserOptions } from './browser-identity';
import {
  type DockviewApi,
  type IDockviewGroupPanel,
  type IDockviewPanel
} from 'dockview';

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
 * Note popout windows use the note_* capability's label namespace. When one is
 * already alive, bring that window forward instead of opening a second editor
 * for the same note.
 */
export async function focusExistingNoteWindow(id: string): Promise<boolean> {
  if (!isTauri()) return false;

  try {
    const win = await WebviewWindow.getByLabel(noteWindowLabel(id));
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

function noteWindowLabel(id: string): string {
  return id.startsWith('note_') ? id : `note_${id}`;
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

  const activePanel: IDockviewPanel | undefined = panelGroup?.activePanel;
  if (
    panelGroup &&
    (!activePanel || !dock || activePanel.params?.noteId !== id)
  ) {
    console.error('[openNoteWindow] source panel is unavailable', id);
    return;
  }
  // Snapshot before async settings reads; the active tab can change while waiting.
  const panelConfig = activePanel && {
    id: activePanel.id,
    component: activePanel.api.component,
    params: { ...activePanel.params },
    title: activePanel.title
  };
  const originalGroupId = panelGroup?.id;
  let detached = false;

  const customWindowDecorations = await getCustomWindowDecorations();
  const browserOptions = await getWorkerBrowserOptions();
  const win = new WebviewWindow(noteWindowLabel(id), {
    ...browserOptions,
    url: `?window=editor&id=${encodeURIComponent(id)}`,
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
  // `.catch`, not `.then()`: registering the listener is itself async, and
  // a bare `.then()` attaches no rejection handler — so a failure to even
  // subscribe used to vanish, which is the opposite of what this is for.
  win
    .once('tauri://error', (e) => {
      console.error('[openNoteWindow] failed to spawn', id, e);
    })
    .catch((err) => {
      console.error(
        '[openNoteWindow] could not subscribe to spawn errors',
        id,
        err
      );
    });

  if (activePanel && dock && panelConfig && originalGroupId) {
    // The native webview-created event can precede a failed WebView2 build.
    // The SDK emits created only after create_webview_window succeeds.
    await win.once('tauri://created', () => {
      if (dock.getPanel(panelConfig.id) === activePanel) {
        dock.removePanel(activePanel);
        detached = true;
      }
    });

    // 3. Re-open the panel when the popout window is closed
    await win.once('tauri://close-requested', async () => {
      // Check if the group still exists, otherwise it defaults to a sensible location
      const targetGroup = dock.getGroup(originalGroupId);

      if (detached && !dock.getPanel(panelConfig.id))
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
