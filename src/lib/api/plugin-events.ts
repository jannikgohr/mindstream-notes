/**
 * Plugin note event cursors in the browser vault. Mirror of
 * src-tauri/storage-core/src/note_events.rs. The app delivers events from its
 * backend, so only the browser host calls these.
 */

import {
  assertRecord,
  assertString,
  assertVoid,
  TauriCommandName,
  invokeOrFallback
} from './core';

export interface NoteChange {
  noteId: string;
  kind: string;
  revision: number;
}

export interface PendingNoteEvents {
  generation: string;
  changes: NoteChange[];
}

function assertPending(value: unknown): PendingNoteEvents {
  const record = assertRecord(value, 'plugin_events_pending response');
  if (!Array.isArray(record.changes))
    throw new Error('plugin_events_pending changes must be an array');
  return {
    generation: assertString(record.generation, 'generation'),
    changes: record.changes.map((change) => {
      const c = assertRecord(change, 'note change');
      if (typeof c.revision !== 'number')
        throw new Error('note change revision must be a number');
      return {
        noteId: assertString(c.noteId, 'noteId'),
        kind: assertString(c.kind, 'kind'),
        revision: c.revision
      };
    })
  };
}

/**
 * Changes to deliver. A change in `settings`, the plugin's effective
 * settings, starts the cursor over.
 */
export function pluginEventsPending(
  pluginId: string,
  exportName: string,
  settings: Record<string, unknown>,
  noteKinds: string[] | undefined,
  settleMs: number,
  limit: number
): Promise<PendingNoteEvents> {
  return invokeOrFallback(
    TauriCommandName.PluginEventsPending,
    { pluginId, export: exportName, settings, noteKinds, settleMs, limit },
    () => ({ generation: '', changes: [] }),
    assertPending
  );
}

export function pluginEventsCommit(
  pluginId: string,
  exportName: string,
  generation: string,
  revision: number
): Promise<void> {
  return invokeOrFallback(
    TauriCommandName.PluginEventsCommit,
    { pluginId, export: exportName, generation, revision },
    () => undefined,
    (value) => assertVoid(value, 'plugin_events_commit response')
  );
}

/** Drops the plugin's cursors when it is disabled or removed. */
export function pluginEventsForget(pluginId: string): Promise<void> {
  return invokeOrFallback(
    TauriCommandName.PluginEventsForget,
    { pluginId },
    () => undefined,
    (value) => assertVoid(value, 'plugin_events_forget response')
  );
}
