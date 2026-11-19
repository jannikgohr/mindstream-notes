/**
 * Run a plugin export in the app's backend, or in the page for the bundled
 * Wasm plugins.
 *
 * The app hands every call to `plugins_run_script`, which merges `settings`,
 * `folders` and `now` into the input before Wasmtime runs the component (see
 * `backend_script_context` in `src-tauri/src/plugins/mod.rs`). Without the app,
 * the bundled components run in `browser-runtime.ts`, and this module builds
 * the same context and note snapshot from the tree and the settings store.
 * Any other plugin still gets the backend's "only available in the app" error.
 */

import { isTauri } from '$lib/api/core';
import { pluginsRunScript } from '$lib/api/plugins';
import { getSettingValue } from '$lib/settings/store.svelte';
import { tree } from '$lib/stores/tree.svelte';
import type { HostNote } from './browser-host';
import { invokeBundledPlugin } from './browser-runtime';
import { pluginById } from './registry.svelte';
import { pluginSettingId } from './settings-store.svelte';
import type { PluginPermission } from './types';

function granted(pluginId: string, permission: PluginPermission): boolean {
  return pluginById(pluginId)?.granted.includes(permission) ?? false;
}

/** The context `backend_script_context` builds, from the browser's own state. */
function browserScriptContext(pluginId: string): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  const sections = pluginById(pluginId)?.manifest.contributes.settings ?? [];
  for (const setting of sections.flatMap((section) => section.settings)) {
    const value = getSettingValue(pluginSettingId(pluginId, setting.id));
    if (value !== undefined) settings[setting.id] = value;
  }
  const folders = granted(pluginId, 'notes.read')
    ? Object.values(tree.collectionsById).map((c) => ({
        id: c.id,
        name: c.name,
        parentId: c.parent_collection_id
      }))
    : [];
  return { settings, folders, now: new Date().toISOString() };
}

/** Folder names from the root down, joined with ` / `, as the backend builds them. */
function folderPath(folderId: string | null): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let current = folderId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const folder = tree.collectionsById[current];
    if (!folder) break;
    parts.push(folder.name);
    current = folder.parent_collection_id;
  }
  return parts.reverse().join(' / ');
}

/** The `notes.*` snapshot `note_snapshot` takes in the backend. */
function browserNotes(pluginId: string): HostNote[] {
  if (!granted(pluginId, 'notes.read')) return [];
  return Object.values(tree.notesById)
    .filter((note) => !note.trashed)
    .map((note) => ({
      id: note.id,
      title: note.title,
      tags: note.tags,
      kind: note.note_kind,
      folderId: note.parent_collection_id ?? undefined,
      folderPath: folderPath(note.parent_collection_id),
      created: note.created,
      modified: note.modified
    }));
}

export async function runPluginScript(
  pluginId: string,
  exportName: string,
  input: unknown
): Promise<unknown> {
  if (isTauri()) return pluginsRunScript(pluginId, exportName, input);
  const plugin = pluginById(pluginId);
  if (plugin && !plugin.enabled)
    throw new Error(`plugin ${pluginId} is not enabled`);
  // Context keys win over the caller's, as they do in the backend.
  const context = browserScriptContext(pluginId);
  const merged =
    input && typeof input === 'object' && !Array.isArray(input)
      ? { ...input, ...context }
      : context;
  return invokeBundledPlugin(exportName, merged, {
    pluginId,
    granted: plugin?.granted ?? [],
    notes: browserNotes(pluginId),
    nativeTools: (plugin?.manifest.contributes.nativeTools ?? []).map(
      (tool) => tool.id
    )
  });
}
