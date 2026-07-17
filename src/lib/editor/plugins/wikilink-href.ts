/**
 * The note-link URL format — the on-disk contract behind a wikilink.
 *
 * A wikilink is not a distinct markdown construct: it's a standard link
 * whose href carries a stable note ID, `[Title](mindstream://note/<id>)`.
 * That's what actually gets serialized, so both editing surfaces have to
 * agree on it — the WYSIWYG plugin decorates it into `[[Title]]`, the
 * source plugin inserts it literally, and `note-link-schema.ts`
 * neutralizes it at render time. Hence a shared module at the plugins
 * root rather than a file under `prose/` or `source/`.
 *
 * IDs are percent-encoded on the way in (see `./link-url` for why that
 * needs more than `encodeURIComponent`), which is why parsing goes
 * through `parseNoteHref` rather than a bare `startsWith` + `slice` at
 * each call site.
 */

import { encodeLinkValue } from './link-url';

const NOTE_LINK_PREFIX = 'mindstream://note/';

export function noteHref(noteId: string): string {
  return `${NOTE_LINK_PREFIX}${encodeLinkValue(noteId)}`;
}

/**
 * The note ID inside a `mindstream://note/…` href, or null for anything
 * else (a normal link, a non-string attr, an empty ID). Callers use the
 * null return as the "is this a note link?" test, so it must stay total.
 *
 * A malformed percent-escape falls back to the raw slice instead of
 * throwing — a link that round-trips to a slightly odd ID is better than
 * one that takes down the decoration pass for the whole document.
 */
export function parseNoteHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  if (!href.startsWith(NOTE_LINK_PREFIX)) return null;
  const raw = href.slice(NOTE_LINK_PREFIX.length);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
