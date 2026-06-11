/**
 * Markdown serialisation for the notes-as-files export.
 *
 * Two pieces:
 *   - YAML frontmatter built from the NoteSummary metadata (title,
 *     timestamps, tags, favourite, kind, id). Hand-rolled — the
 *     handful of types we serialise (strings, dates, booleans, string
 *     arrays) don't justify pulling js-yaml into the bundle.
 *   - Asset URL rewrite: every `mindstream-asset://<id>` reference in
 *     the body is swapped for a relative `_assets/<id>.<ext>` path so
 *     the exported folder opens cleanly in any markdown reader.
 */

import type { Note } from '$lib/api';

export interface FrontmatterFields {
  title: string;
  created: string;
  modified: string;
  tags: string[];
  favourite: boolean;
  kind: string;
  id: string;
}

/**
 * Render a single frontmatter block.
 *
 * Strings are emitted with double-quoting when they contain `:`, `#`,
 * `"`, leading whitespace, or non-printable characters — that's the
 * conservative subset YAML 1.2 requires quoting for. Everything else
 * is left bare so the result reads like Obsidian-style frontmatter.
 */
export function renderFrontmatter(f: FrontmatterFields): string {
  const lines: string[] = ['---'];
  lines.push(`title: ${yamlScalar(f.title)}`);
  lines.push(`id: ${yamlScalar(f.id)}`);
  lines.push(`kind: ${yamlScalar(f.kind)}`);
  lines.push(`created: ${yamlScalar(f.created)}`);
  lines.push(`modified: ${yamlScalar(f.modified)}`);
  if (f.favourite) lines.push('favourite: true');
  if (f.tags.length > 0) {
    lines.push('tags:');
    for (const t of f.tags) lines.push(`  - ${yamlScalar(t)}`);
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

function yamlScalar(raw: string): string {
  // YAML 1.2 only treats `:` and `#` as special when followed by
  // whitespace (the key-value boundary and inline-comment markers).
  // Inside ISO timestamps (`2026-06-10T14:00:00Z`) the colons sit
  // between digits, so this preserves them bare and keeps the
  // frontmatter readable.
  const needsQuoting =
    /^[\s]/.test(raw) ||
    /[:#](\s|$)/.test(raw) ||
    /["\n\r\t]/.test(raw) ||
    /^[-?!&*|>%@`]/.test(raw);
  if (!needsQuoting) return raw;
  // Double-quoted YAML supports \" and \\ escapes, which is enough
  // for our string set (titles, tags, ISO timestamps).
  return `"${raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Find every `mindstream-asset://<id>` reference in the markdown body
 * and return the unique ids in encounter order.
 */
export function extractAssetIds(body: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const re = /mindstream-asset:\/\/([A-Za-z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Rewrite the body so each `mindstream-asset://<id>` URL becomes
 * `<assetSubdir>/<asset_filename>`, where the per-asset filename is
 * resolved through the `assetFilename` lookup. Unknown ids pass
 * through unchanged so we never silently drop a reference.
 */
export function rewriteAssetUrls(
  body: string,
  assetSubdir: string,
  assetFilename: (id: string) => string | undefined
): string {
  return body.replace(
    /mindstream-asset:\/\/([A-Za-z0-9_-]+)/g,
    (whole, id: string) => {
      const filename = assetFilename(id);
      if (!filename) return whole;
      // Forward-slashes are valid in relative paths on every OS that
      // can open a markdown file. Avoid backslashes — they're an
      // escape sequence in markdown text.
      return `${assetSubdir}/${filename}`;
    }
  );
}

/** Convenience: build the complete `.md` payload from a `Note`. */
export function renderMarkdownFile(note: Note, rewrittenBody: string): string {
  const fm = renderFrontmatter({
    title: note.title,
    id: note.id,
    kind: note.note_kind,
    created: note.created,
    modified: note.modified,
    tags: note.tags,
    favourite: note.favourite
  });
  // Trim leading whitespace on the body so the blank line after the
  // closing `---` is the only separator the reader sees.
  return `${fm}${rewrittenBody.replace(/^\s+/, '')}`;
}
