/**
 * Loads a plugin's file-backed documentation sections.
 *
 * A plugin declares its docs as an ordered list of `.md` files
 * (`contributes.documentation`); this module resolves and reads them, honouring
 * the active locale by filename suffix. For `file: "docs/guide.md"` and locale
 * `de`, it tries `docs/guide.de.md` and falls back to `docs/guide.md` — the same
 * active-locale→English fallback used across the app.
 *
 * Reading + locale fallback go through the shared `readPluginFile` (Tauri
 * backend or the browser build-time glob). The section's nav title is the
 * markdown's first `# H1`, falling back to a prettified filename — so authors
 * never write title strings in the manifest.
 */

import { i18n } from '$lib/settings/i18n.svelte';
import { readPluginFile } from './plugin-files';
import type { PluginDocSection } from './types';

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
