/**
 * Which optional note types the user has enabled. The core `markdown` type is
 * always available; every other kind is gated behind an `editor.noteTypes.<kind>`
 * toggle (see `settings/schema.json`) so a user who never touches drawings, PDFs
 * or boards isn't shown create entries for them.
 *
 * Create menus (desktop + mobile) call {@link noteTypeEnabled} to decide which
 * entries to render. Reads flow through `getSettingValue`, so a menu built
 * inside a `$derived`/`$effect` re-evaluates when a toggle flips.
 */

import type { NoteKind } from '$lib/api';
import { getSettingValue } from '$lib/settings/store.svelte';

/** Optional (togglable) note kinds — everything except always-on `markdown`. */
export type OptionalNoteKind = Exclude<NoteKind, 'markdown'>;

/** True when the given note kind should be offered in create menus. */
export function noteTypeEnabled(kind: NoteKind): boolean {
  if (kind === 'markdown') return true;
  // Absent/unknown settings default to enabled — matches the schema defaults
  // and keeps a note type visible if its toggle hasn't hydrated yet.
  return getSettingValue(`editor.noteTypes.${kind}`) !== false;
}
