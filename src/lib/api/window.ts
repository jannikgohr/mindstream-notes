/**
 * Window-management bridge. Popouts are spawned from the frontend via
 * Tauri's WebviewWindow constructor — keeping it on this side avoids a
 * Rust round-trip and lets the +page.svelte route read the window label
 * directly to decide what to render.
 */

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isTauri } from './core';
import { emitTo, TauriEventName } from './events';
import { getCustomWindowDecorations } from './desktop-settings';
import { getWorkerBrowserOptions } from './browser-identity';
import { currentThemeWindowBackground } from '$lib/settings/theme-presets';
import { flushPendingEditorSaves } from '$lib/editor/suspend-flush';
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
  return currentThemeWindowBackground();
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

/**
 * Open a note in a window of its own, from a window other than the main one.
 *
 * Only the main window knows every tab and window a note is open in. It
 * focuses the note's window if there is one, moves the note's tab into a
 * new window if there is one of those, and opens a window otherwise. A note
 * window that opened one itself could not see the main window's tabs, and
 * two editors on one note save over each other.
 */
export async function requestNoteWindow(
  id: string,
  title: string
): Promise<void> {
  // Browser preview: no main window to ask, and no dock to move a tab from.
  if (!isTauri()) return openNoteWindow(id, title, null, null);
  await emitTo('main', TauriEventName.NoteWindowRequested, { noteId: id });
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
  // The new window reads the note from storage. Whatever the docked editor
  // still holds is saved first, or the popout would open on older text and
  // its next save would replace the newer one. If that save fails, the tab
  // stays where it is with its edits. Saved last before the window is made,
  // so little can be typed in between. What is goes with the tab's teardown
  // save once the window is created, which is captured at once and normally
  // lands well before the new window has booted and loaded the note.
  if (activePanel) {
    try {
      await flushPendingEditorSaves();
    } catch (err) {
      console.error('[openNoteWindow] could not save before moving', id, err);
      return;
    }
  }

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

    // Reopen only after the popout has saved and actually closed. A close
    // request may be cancelled if saving fails.
    await win.once('tauri://destroyed', () => {
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
    });
  }
}
