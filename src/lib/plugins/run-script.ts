/**
 * Run a plugin export in the app's backend, or in the browser for the one
 * plugin the browser can run.
 *
 * The app hands every call to `plugins_run_script`, which merges `settings`,
 * `folders` and `now` into the input before Wasmtime runs the component (see
 * `backend_script_context` in `src-tauri/src/plugins/mod.rs`). Without the app,
 * only the bundled Templates plugin runs, through its TypeScript port in
 * `browser-templates.ts`. This module builds the same context for it from the
 * tree and the settings store. Any other plugin still gets the backend's
 * "only available in the app" error.
 */

import { isTauri } from '$lib/api/core';
import { pluginsRunScript } from '$lib/api/plugins';
import { getSettingValue } from '$lib/settings/store.svelte';
import { tree } from '$lib/stores/tree.svelte';
import { invokeTemplatesPlugin } from './browser-templates';
import { pluginById } from './registry.svelte';
import { pluginSettingId } from './settings-store.svelte';
import type { PluginPermission } from './types';

const TEMPLATES_PLUGIN_ID = 'com.mindstream.templates.core';

/** `runtime.uuid`. `randomUUID` needs a secure context, which plain HTTP lacks. */
function newUuid(): string {
  // Typed as always present, but missing outside secure contexts.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    ''
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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

function browserNotes(pluginId: string) {
  if (!granted(pluginId, 'notes.read'))
    throw new Error(`plugin "${pluginId}" lacks the notes.read permission`);
  return Object.values(tree.notesById)
    .filter((note) => !note.trashed)
    .map((note) => ({
      id: note.id,
      title: note.title,
      tags: note.tags,
      folderId: note.parent_collection_id
    }));
}

export async function runPluginScript(
  pluginId: string,
  exportName: string,
  input: unknown
): Promise<unknown> {
  if (isTauri() || pluginId !== TEMPLATES_PLUGIN_ID)
    return pluginsRunScript(pluginId, exportName, input);
  // Context keys win over the caller's, as they do in the backend.
  const context = browserScriptContext(pluginId);
  const merged =
    input && typeof input === 'object' && !Array.isArray(input)
      ? { ...input, ...context }
      : context;
  return invokeTemplatesPlugin(exportName, merged, {
    notes: () => browserNotes(pluginId),
    uuid: newUuid
  });
}
