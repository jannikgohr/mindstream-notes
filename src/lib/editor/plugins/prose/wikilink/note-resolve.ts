/**
 * Resolving a wikilink to a note.
 *
 * ID-backed links carry the note id in their href and need no lookup;
 * legacy literal `[[Title]]` spans fall back to a title match against the
 * loaded tree, which is why both directions live here.
 */

import { tree } from '$lib/stores/tree.svelte';

/* --- Note link resolution -------------------------------------------------- */

// The href format itself is shared with the source-mode plugin (and the
// render-time neutralizer), so it lives at the plugins root. Re-exported
// here so wikilink consumers can still reach everything through this module.
export { noteHref, parseNoteHref } from '../../wikilink-href';

export function resolveNoteTitleById(id: string, fallback: string): string {
  const title = tree.notesById[id]?.title.trim();
  return title || fallback;
}

/**
 * Find a note by exact title (case-insensitive). Excludes trashed notes
 * so a "ghost" title from the trash doesn't take precedence over a
 * real note with the same name.
 *
 * Same-title collisions: returns the most-recently-modified match.
 * That's arbitrary but stable per snapshot of the tree, and in practice
 * users notice the conflict quickly because the popup itself shows
 * both entries.
 */
export function resolveNoteIdByTitle(title: string): string | null {
  const wanted = title.trim().toLowerCase();
  if (!wanted) return null;
  let best: { id: string; modified: string } | null = null;
  for (const note of Object.values(tree.notesById)) {
    if (note.trashed) continue;
    if (note.title.trim().toLowerCase() !== wanted) continue;
    if (!best || note.modified > best.modified) {
      best = { id: note.id, modified: note.modified };
    }
  }
  return best?.id ?? null;
}
