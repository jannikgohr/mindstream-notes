/**
 * Reads a plugin's bundled text assets (docs `.md`, icon `.svg`, …) behind one
 * API, over two backends:
 *
 *   - **Tauri** — the backend reads the file from the plugin dir, path-guarded
 *     (`plugins_read_file`).
 *   - **browser build** — there is no filesystem, so the bundled core plugins'
 *     assets are pulled in at build time via `import.meta.glob(..?raw)`. Only
 *     bundled core plugins are present in a browser build; third-party plugins
 *     never reach it (they need the Tauri filesystem).
 *
 * Consumed by `docs-loader.ts` (markdown sections) and `plugin-assets.ts`
 * (SVG icons).
 */

import { isTauri } from '$lib/api/core';
import { pluginsReadFile } from '$lib/api/plugins';

// Globs are relative to this file (src/lib/plugins/), reaching the repo-root
// `plugins/` dir the same way load.ts imports the bundled manifest.
const manifestModules = import.meta.glob<{
  id?: string;
  default?: { id?: string };
}>('../../../plugins/*/manifest.json', { eager: true });
const assetModules = import.meta.glob<string>(
  '../../../plugins/*/**/*.{md,svg}',
  { query: '?raw', import: 'default', eager: true }
);

/** Extract `<folder>` and the plugin-relative path from a globbed file path. */
function splitPluginPath(path: string): { folder: string; rel: string } | null {
  const m = /\/plugins\/([^/]+)\/(.+)$/.exec(path);
  return m ? { folder: m[1], rel: m[2] } : null;
}

/** plugin id → its bundling folder name, from the globbed manifests. */
const folderById: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [path, mod] of Object.entries(manifestModules)) {
    const split = splitPluginPath(path);
    const id = mod.default?.id ?? mod.id;
    if (split && typeof id === 'string') out[id] = split.folder;
  }
  return out;
})();

/** `<folder>/<relPath>` → raw file contents, from the globbed assets. */
const assetByKey: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(assetModules)) {
    const split = splitPluginPath(path);
    if (split) out[`${split.folder}/${split.rel}`] = content;
  }
  return out;
})();

/** Read one exact plugin-relative file, or `null` if absent. */
export async function readPluginFile(
  pluginId: string,
  rel: string
): Promise<string | null> {
  if (isTauri()) return pluginsReadFile(pluginId, rel);
  const folder = folderById[pluginId];
  if (!folder) return null;
  return assetByKey[`${folder}/${rel}`] ?? null;
}
