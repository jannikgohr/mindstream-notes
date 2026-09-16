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
 *
 * @deprecated Note links are `[Title](mindstream://note/<id>)`; nothing
 * produces a bare `[[Title]]` any more. The importer resolves links once, at
 * import time, and Settings → Data → "Convert legacy links" rewrites the ones
 * already in the vault. This remains only so pre-existing bodies keep working
 * until that has run: resolving at click time is guesswork — the same link can
 * lead to different notes as titles are edited, and a rename breaks it
 * silently. Do not add new callers; delete it once the decoration pass no
 * longer needs it.
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
