/**
 * Reactive store of user-customised hotkey bindings.
 *
 * Persistence rides on top of the existing settings store: each
 * command's binding is held as a setting whose id is
 * `'hotkey.' + command.id`. We didn't add a row per hotkey to
 * `schema.json` because:
 *
 *   - the schema is meant to be *authored* JSON, and 17+ identical
 *     skeletons of `{ scope:'V', type:'keybinding', default:'mod+...' }`
 *     would be tedious to maintain alongside the catalogue;
 *   - the catalogue is already the source of truth for defaults and
 *     labels, and duplicating that into schema.json would be a
 *     guaranteed-to-rot mirror;
 *   - the settings store's `getSettingValue` / `setSettingValue`
 *     happily take any id, schema-listed or not — the schema is only
 *     consulted for type info and default lookup, both of which we
 *     provide ourselves here.
 *
 * Conflict policy: at most one command per chord. When the user sets a
 * binding that's already in use, the old owner is silently cleared.
 * The settings UI warns about this before the write happens; the store
 * itself trusts the caller and just performs the swap so internal
 * invariants (`bindingToCommand` is single-valued) hold.
 */

import { setSettingValue, settings } from '$lib/settings/store.svelte';
import { canonicalize } from './parse';
import {
  COMMAND_BY_ID,
  HOTKEY_COMMANDS,
  type CommandDefinition
} from './commands';

/**
 * Settings-store key for a given command id. The `'hotkey.'` prefix
 * keeps these clearly distinct from regular settings (`'editor.'`,
 * `'appearance.'`, …) so a stale binding doesn't accidentally collide
 * with a future setting id.
 */
function settingKey(commandId: string): string {
  return `hotkey.${commandId}`;
}

/**
 * Read the active binding for a command, falling back to its default
 * when the user has never customised it. Returns `null` only when the
 * user has explicitly unset the hotkey — i.e. there is no fallback to a
 * default in that case. That's deliberate: "unset" must mean "no key",
 * not "no key for now, then default again later", or unsetting would
 * appear to do nothing.
 */
export function getBinding(commandId: string): string | null {
  const def = COMMAND_BY_ID[commandId];
  if (!def) return null;
  const key = settingKey(commandId);
  if (key in settings.values) {
    const raw = settings.values[key];
    // We accept `null` (explicit unset), a string (custom binding), and
    // refuse anything else. A corrupt localStorage row therefore falls
    // back to the default rather than blowing up the reader.
    if (raw === null) return null;
    if (typeof raw === 'string') return canonicalize(raw);
    return def.defaultBinding;
  }
  return def.defaultBinding;
}

/**
 * Set a new binding, persisted via the settings store. Pass `null` to
 * mark the hotkey as unset (no key fires it).
 *
 * Conflict resolution: if `binding` is non-null and currently in use
 * by another command, that other command is silently cleared so the
 * single-binding invariant holds. The caller (settings UI) is expected
 * to have surfaced this beforehand.
 */
export async function setBinding(
  commandId: string,
  binding: string | null
): Promise<void> {
  const def = COMMAND_BY_ID[commandId];
  if (!def) return;
  const normalized = binding === null ? null : canonicalize(binding);
  // Refuse to persist a binding that doesn't parse. The recorder UI
  // is responsible for only handing us valid input — if we got here
  // with garbage, the alternative would be silently storing a string
  // that the manager could never match.
  if (binding !== null && normalized === null) {
    throw new Error(`[hotkeys] refused to store invalid binding: ${binding}`);
  }

  if (normalized !== null) {
    for (const other of HOTKEY_COMMANDS) {
      if (other.id === commandId) continue;
      const otherBinding = getBinding(other.id);
      if (otherBinding === normalized) {
        await setSettingValue(settingKey(other.id), null);
      }
    }
  }

  await setSettingValue(settingKey(commandId), normalized);
}

/** Restore a command's default binding. Behaviour matches `setBinding`
 *  with `defaultBinding` as the value: defaults can also collide with
 *  customised entries so the swap rules apply. */
export async function resetBinding(commandId: string): Promise<void> {
  const def = COMMAND_BY_ID[commandId];
  if (!def) return;
  await setBinding(commandId, def.defaultBinding);
}

/** True when the user's binding differs from the catalogue default —
 *  used by the settings UI to draw the small "modified" dot next to
 *  custom rows. */
export function isCustomized(commandId: string): boolean {
  const def = COMMAND_BY_ID[commandId];
  if (!def) return false;
  const key = settingKey(commandId);
  if (!(key in settings.values)) return false;
  const current = getBinding(commandId);
  return current !== def.defaultBinding;
}

/**
 * Build the reverse map { normalized-binding → command id } for fast
 * dispatch. Recomputed inline because the manager calls
 * `findCommandByBinding` on every keydown and the catalogue is small
 * (well under 100 entries) — a memoized derived would be a marginal
 * win we don't need. Reading is dependency-tracked through
 * `settings.values`, so changes invalidate any `$derived` chain that
 * built up from this call automatically.
 */
export function findCommandByBinding(
  binding: string
): CommandDefinition | null {
  for (const cmd of HOTKEY_COMMANDS) {
    const b = getBinding(cmd.id);
    if (b === binding) return cmd;
  }
  return null;
}
