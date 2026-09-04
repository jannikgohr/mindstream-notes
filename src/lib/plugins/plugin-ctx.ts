/**
 * The **UI half** of the context a plugin's backend script receives.
 *
 * The backend supplies the rest — `settings` from the database, `folders`
 * gated on `notes.read`, and `now` from the host clock — and its values win on
 * a collision (see `backend_script_context` in `src-tauri/src/plugins/mod.rs`).
 * That split is what lets the backend invoke a plugin without a UI action
 * behind it: everything security-relevant it can build for itself.
 *
 * What is left here is genuinely UI state, which the backend has no view of:
 * which note is on screen, and which locale the window is showing.
 *
 * Kept in its own module so both `effects.ts` and `templates.ts` can use it
 * without an import cycle.
 */

import { i18n } from '$lib/settings/i18n.svelte';
import { ui } from '$lib/state.svelte';

/**
 * `{ activeNoteId, locale }` — the part of the script context only the window
 * knows. The backend merges `settings`, `folders` and `now` over this.
 */
export function buildPluginContext(): Record<string, unknown> {
  return {
    activeNoteId: ui.activeNoteId ?? null,
    locale: i18n.language
  };
}
