/**
 * Loads a plugin's file-backed documentation sections.
 *
 * A plugin declares its docs as an ordered list of `.md` files
 * (`contributes.documentation`); this module resolves and reads them, honouring
 * the active locale by filename suffix. For `file: "docs/guide.md"` and locale
 * `de`, it tries `docs/guide.de.md` and falls back to `docs/guide.md` — the same
 * active-locale→English fallback used across the app.
 *
 * Two read paths behind one API:
 *   - **Tauri** — the backend reads the file from the plugin dir (path-guarded);
 *   - **browser build** — the bundled core plugins' docs are pulled in at build
 *     time via `import.meta.glob(..?raw)`, since there is no filesystem.
 *
 * The section's nav title is the markdown's first `# H1`, falling back to a
 * prettified filename — so authors never write title strings in the manifest.
 */

import { isTauri } from '$lib/api/core';
import { pluginsReadDoc } from '$lib/api/plugins';
import { i18n } from '$lib/settings/i18n.svelte';
import type { PluginDocSection } from './types';

/* --- Browser build: bundled core-plugin docs -------------------------------
 *
 * Globs are relative to this file (src/lib/plugins/), reaching the repo-root
 * `plugins/` dir the same way load.ts imports the bundled manifest. Only the
 * bundled core plugins are present in a browser build; third-party plugins never
 * reach it (they need the Tauri filesystem).
 */
const manifestModules = import.meta.glob<{
  id?: string;
  default?: { id?: string };
}>('../../../plugins/*/manifest.json', { eager: true });
const docModules = import.meta.glob<string>('../../../plugins/*/docs/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true
});

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

/** `<folder>/<relPath>` → raw markdown, from the globbed doc files. */
const docByKey: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(docModules)) {
    const split = splitPluginPath(path);
    if (split) out[`${split.folder}/${split.rel}`] = content;
  }
  return out;
})();

/** Read one exact plugin-relative file, or `null` if absent. */
async function readPluginFile(
  pluginId: string,
  rel: string
): Promise<string | null> {
  if (isTauri()) return pluginsReadDoc(pluginId, rel);
  const folder = folderById[pluginId];
  if (!folder) return null;
  return docByKey[`${folder}/${rel}`] ?? null;
}

/** `docs/guide.md` + `de` → `docs/guide.de.md`. */
function withLocaleSuffix(file: string, locale: string): string {
  return file.replace(/\.md$/i, `.${locale}.md`);
}

/**
 * The candidate paths for a section, most-specific first: the active-locale
 * variant, then the base file. Deduped so an `en` base doesn't read twice.
 */
export function docCandidates(file: string, locale: string): string[] {
  const localized = withLocaleSuffix(file, locale);
  return localized === file ? [file] : [localized, file];
}

/** Prettify a filename into a title when a section has no `# H1`. */
function titleFromFile(file: string): string {
  const base = file.split('/').pop() ?? file;
  return base
    .replace(/\.md$/i, '')
    .replace(/\.[a-z]{2}(-[a-z]{2})?$/i, '') // drop a trailing locale suffix
    .replace(/^\d+[-_]/, '') // drop an ordering prefix like "01-"
    .replace(/[-_]+/g, ' ')
    .trim();
}

/** The section's nav title: its first `# H1`, else a prettified filename. */
export function extractDocTitle(markdown: string, file: string): string {
  const m = /^#\s+(.+?)\s*$/m.exec(markdown);
  return m ? m[1].trim() : titleFromFile(file);
}

/** A loaded doc section ready to render + list in the nav. */
export interface LoadedDocSection {
  file: string;
  title: string;
  markdown: string;
}

/**
 * Load one section's markdown for the active locale, falling back to the base
 * file. Returns `null` when no candidate exists (a misdeclared file).
 */
export async function loadDocSection(
  pluginId: string,
  section: PluginDocSection
): Promise<LoadedDocSection | null> {
  for (const rel of docCandidates(section.file, i18n.language)) {
    const markdown = await readPluginFile(pluginId, rel);
    if (markdown !== null) {
      return {
        file: section.file,
        title: extractDocTitle(markdown, section.file),
        markdown
      };
    }
  }
  return null;
}

/** Load every declared section in order, dropping any that fail to resolve. */
export async function loadPluginDocs(
  pluginId: string,
  sections: PluginDocSection[]
): Promise<LoadedDocSection[]> {
  const loaded = await Promise.all(
    sections.map((s) => loadDocSection(pluginId, s))
  );
  return loaded.filter((s): s is LoadedDocSection => s !== null);
}
