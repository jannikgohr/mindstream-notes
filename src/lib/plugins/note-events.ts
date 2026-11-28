/**
 * Delivers note events to browser plugins. Mirror of the backend loop in
 * src-tauri/src/plugins/events.rs; the cursor and settling rules are shared in
 * storage-core. Only the tab that owns the vault can reach its storage, so
 * other tabs deliver nothing.
 */

import { isTauri } from '$lib/api/core';
import {
  pluginEventsCommit,
  pluginEventsPending
} from '$lib/api/plugin-events';
import { pluginById, pluginNoteEvents } from './registry.svelte';
import { browserPluginSettings, runPluginScript } from './run-script';

/** `TICK` and `BATCH` in events.rs. */
const TICK_MS = 1000;
const BATCH = 50;

/**
 * One pass over every subscription. A handler that fails still moves the
 * cursor: the event was delivered, and retrying it would block the plugin.
 */
export async function deliverNoteEvents(): Promise<void> {
  for (const { pluginId, event } of pluginNoteEvents()) {
    const pending = await pluginEventsPending(
      pluginId,
      event.export,
      browserPluginSettings(pluginId),
      event.noteKinds,
      event.settleMs ?? 0,
      BATCH
    );
    for (const change of pending.changes) {
      try {
        await runPluginScript(pluginId, event.export, { ...change });
      } catch (err) {
        // Turned off meanwhile, so the export never ran. Keep the event.
        if (!pluginById(pluginId)?.enabled) break;
        console.warn(
          `[plugins] ${pluginId} ${event.export} failed for ${change.noteId}`,
          err
        );
      }
      await pluginEventsCommit(
        pluginId,
        event.export,
        pending.generation,
        change.revision
      );
    }
  }
}

let started = false;

export function startNoteEvents(): void {
  if (isTauri() || started) return;
  started = true;
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    deliverNoteEvents()
      .catch((err) => console.debug('[plugins] note events paused', err))
      .finally(() => (running = false));
  }, TICK_MS);
}
