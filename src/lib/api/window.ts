/**
 * Window-management bridge. Popouts are spawned from the frontend via
 * Tauri's WebviewWindow constructor — keeping it on this side avoids a
 * Rust round-trip and lets the +page.svelte route read the window label
 * directly to decide what to render.
 */

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isTauri } from './index';
import {DockviewApi, type IDockviewGroupPanel, type IDockviewPanel} from "dockview-core";

export interface MSPanelElement extends IDockviewPanel {
  component: string,
}

export async function openNoteWindow(
    id: string,
    title: string,
    panelGroup: IDockviewGroupPanel | null,
    dock: DockviewApi | null): Promise<void> {

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
    dragDropEnabled: false
  });

  // Surface failures so future regressions show up in the console instead
  // of silently producing a half-broken window.
  win.once('tauri://error', (e) => {
    console.error('[openNoteWindow] failed to spawn', id, e);
  }).then();

  if (panelGroup) {
    const activePanel: MSPanelElement | undefined = panelGroup?.activePanel as MSPanelElement;

    if (!activePanel || !dock) {
      console.error('[openNoteWindow] failed to spawn because activePanel or dockApi was null',
          id, activePanel, dock);
      return;
    }

    // 1. Snapshot the panel state before it vanishes
    const panelConfig = {
      id: activePanel.id,
      component: activePanel.component, // e.g., 'noteEditor'
      params: { ...activePanel.params },
      title: activePanel.title
    };

    const originalGroupId = panelGroup.id;

    // 2. Close the original panel once the window is ready
    await win.once('tauri://webview-created', () => {
      dock.removePanel(activePanel)
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
        ...(targetGroup ? { position: { referenceGroup: originalGroupId } } : {})
      });

      // Close the Tauri window
      await win.close();
    });
  }
}
