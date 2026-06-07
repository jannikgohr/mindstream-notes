/**
 * Command-id migrations for persisted hotkey bindings.
 *
 * When we rename a command id — `editor.markdown.bulletList` →
 * something else — users with custom bindings would silently lose
 * them: hydrate reads the new id, finds no `settings.values` entry,
 * falls back to the catalogue default. The user's customisation just
 * disappears.
 *
 * The fix is small: maintain a map of `OLD id → NEW id`. At hydrate
 * time, before the main load, walk every entry. For each migration:
 *
 *   1. If `hotkey.<OLD>` is in `settings.values`, copy the value to
 *      `hotkey.<NEW>` — UNLESS `<NEW>` already has a value, in which
 *      case the user's more recent choice wins.
 *   2. Always delete `hotkey.<OLD>` afterwards so the row never
 *      re-applies on the next load.
 *
 * Migrations are single-step on purpose. If a multi-step chain ever
 * lands (A → B → C), express it as both A→C and B→C in the same
 * release. Chains are tempting but introduce ordering hazards: the
 * walk order would have to be specified, and a bug there means the
 * user's binding lands in the wrong place.
 *
 * Authoring rules — enforced by `migrations.test.ts`:
 *   - The target must be a real command id in the catalogue.
 *   - The source must NOT be a real command id (a live id can't be
 *     "the old name" of something else).
 *   - No source may appear as another entry's target (no chains).
 *   - Self-references (`id → id`) are forbidden.
 *
 * Empty by design until the first rename ships. The infrastructure
 * is here so the SECOND rename doesn't need to invent it under
 * deadline pressure.
 */

/**
 * Settings-store prefix used by every hotkey row. Mirrors the one in
 * `store.svelte.ts`; duplicated here on purpose so this module doesn't
 * pull in the reactive surface for what is fundamentally a
 * data-only operation. The two strings being out of sync would be a
 * bug, but they're three characters apart and live next to each
 * other in code review.
 */
const SETTING_PREFIX = 'hotkey.';

/**
 * The canonical migration table. KEYS are the OLD ids that may still
 * be present in older users' localStorage; VALUES are the new ids
 * we've renamed them to.
 *
 * Example entry (illustrative — none currently shipped):
 *
 *     'editor.markdown.bulletList': 'editor.markdown.unorderedList'
 *
 * When you rename a command:
 *   1. Update the id everywhere in code (catalogue, MARKDOWN_ACTIONS,
 *      i18n labels, toolbar refs, …).
 *   2. Add an entry here mapping old → new.
 *   3. Add a test in `migrations.test.ts` asserting the migration
 *      moves a sample value correctly.
 *   4. Never remove entries from this map — old users may upgrade
 *      from any prior version, including very old ones.
 */
export const MIGRATIONS: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Apply migrations to a settings values map IN PLACE.
 *
 * Pure (no reactive store access, no I/O) so tests can drive it with
 * synthetic input. The real caller is `hydrateBindingsFromSettings`,
 * which passes `settings.values` and the canonical `MIGRATIONS`.
 *
 *   - Iterates the migration table; for each `OLD → NEW`:
 *     - If `hotkey.<OLD>` exists in `values`:
 *       - If `hotkey.<NEW>` does NOT exist, copy the value across.
 *       - Always delete `hotkey.<OLD>`.
 *   - Never touches rows that aren't named in the table.
 *
 * Order of the migration entries doesn't matter — every entry is
 * single-step (the authoring rules forbid chains), so the only
 * source of cross-talk would be two entries with the same target,
 * which the test suite rejects.
 */
export function applyMigrations(
  values: Record<string, unknown>,
  migrations: Readonly<Record<string, string>>
): void {
  for (const [oldId, newId] of Object.entries(migrations)) {
    const oldKey = SETTING_PREFIX + oldId;
    if (!(oldKey in values)) continue;
    const newKey = SETTING_PREFIX + newId;
    if (!(newKey in values)) {
      values[newKey] = values[oldKey];
    }
    delete values[oldKey];
  }
}
