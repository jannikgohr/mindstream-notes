/**
 * Which note kinds record a History timeline.
 *
 * History is on for every supported note kind by default — the built-in kinds
 * and plugin-owned kinds (e.g. a Typst document) alike. The opt-out is
 * deliberately an *in-code* switch, not a user setting: add a kind to
 * {@link HISTORY_DISABLED_KINDS} to remove its timeline app-wide. Both the
 * capture side (the editors) and the UI gate (the sidebar's History panel)
 * consult {@link noteHistoryEnabled}, so the two can never drift.
 */

import { isSupportedNoteKind } from '$lib/api';

/**
 * Note kinds excluded from history *in code* — empty by default, so history is
 * recorded and shown everywhere. Add a `NoteKind` string to disable one kind's
 * timeline, e.g. a specific `plugin.<id>.<kind>` or a built-in like `'ink'`.
 */
const HISTORY_DISABLED_KINDS: ReadonlySet<string> = new Set<string>();

/** True when the History timeline should be recorded + shown for `kind`. */
export function noteHistoryEnabled(kind: string | null | undefined): boolean {
  return isSupportedNoteKind(kind) && !HISTORY_DISABLED_KINDS.has(kind);
}
