/**
 * Reactive store of user-customised hotkey bindings.
 *
 * Two layers, deliberately separated:
 *
 *   1. **Reactive surface** — `hotkeys.bindings` is a `$state` map of
 *      `commandId → binding | null`. Every UI consumer (toolbar
 *      tooltips, the menu shortcut column, the settings panel) reads
 *      this map directly via `getBinding(id)`. Because each commandId
 *      is its own property of the proxy, a write to one key
 *      invalidates only the readers of that key — exactly the
 *      i18n.bundle / setLanguage model. No "void settings.values"
 *      tracking hack; the reactivity is per-binding.
 *
 *   2. **Persistence** — the underlying settings store is still where
 *      bindings end up on disk, under the key prefix `'hotkey.'`.
 *      `setBinding` mirrors writes through to it so the value survives
 *      a reload and the existing localStorage migration / debounce
 *      machinery applies. Reads at module-load time pull initial
 *      values out of `settings.values` so a refresh comes back with
 *      whatever the user last picked.
 *
 * The split is the same trick `mode-watcher` and `i18n.svelte.ts` use:
 * the source of truth is in a fast in-memory `$state` so the UI feels
 * instant, the disk is just where the value goes for next time.
 *
 * Negative-space rules:
 *
 *   - `getBinding` never returns an unknown value type. If the
 *     localStorage row is corrupt (number, object, …) we fall back to
 *     the default — the manager / UI never sees garbage.
 *
 *   - `setBinding` refuses to persist a string that doesn't round-trip
 *     through `parseBinding`. Anything that gets stored is guaranteed
 *     to be a chord the matcher can recognise.
 *
 *   - Single-binding invariant: at most one command owns a given chord.
 *     Setting a binding that's already in use is rejected with a
 *     `HotkeyBindingConflictError` so callers can show the rejected
 *     shortcut next to the row the user is editing.
 */

import { setSettingValue, settings } from '$lib/settings/store.svelte';
import { canonicalize } from './parse';
import { wellKnownConflict } from './collisions';
import { applyMigrations, MIGRATIONS } from './migrations';
import {
  COMMAND_BY_ID,
  HOTKEY_COMMANDS,
  type CommandDefinition
} from './commands';

/** Settings-store key for a given command id. The `'hotkey.'` prefix
 *  keeps these clearly distinct from regular settings (`'editor.'`,
 *  `'appearance.'`, …) so a stale binding doesn't collide with a
 *  future setting id. */
function settingKey(commandId: string): string {
  return `hotkey.${commandId}`;
}

/**
 * The reactive binding map. Same shape as the i18n.bundle pattern:
 * a single `$state` object, mutated in place, read by the entire app.
 *
 * Exported directly so callers can subscribe in `$derived` chains
 * without going through a helper — `displayBinding(hotkeys.bindings[id])`
 * is the canonical reactive read. `getBinding(id)` is the same thing
 * with a null-safe fallback baked in.
 *
 * Starts empty (NOT populated with catalogue defaults) so module init
 * doesn't depend on `HOTKEY_COMMANDS` being fully loaded — there's a
 * transitive import cycle (settings.registry → HotkeysPanel →
 * $lib/hotkeys → store → commands → editor-toolbar/commands) that
 * would otherwise make `HOTKEY_COMMANDS` undefined at the time this
 * file evaluates. Defaults are served lazily by `getBinding`, and
 * `hydrateBindingsFromSettings` overlays user-saved overrides at
 * `initHotkeys` time.
 */
export const hotkeys = $state<{
  bindings: Record<string, string | null>;
}>({
  bindings: {}
});

/**
 * Pull user-saved bindings out of the settings store and into the
 * reactive `hotkeys.bindings` map. Idempotent — re-running just
 * re-overwrites every command's entry from the current settings
 * snapshot, so callers don't need to track whether hydration has
 * happened.
 *
 * Defensive against settings being only partially loaded (corrupt
 * localStorage, in-flight Tauri IPC for a binding-backed value): an
 * unknown row type falls back to the catalogue default, never throws.
 */
export function hydrateBindingsFromSettings(): void {
  if (!settings || !settings.values) return;
  // Defensive: HOTKEY_COMMANDS is populated synchronously at module
  // load, but if a future caller triggers hydration mid-circular-load
  // we'd rather skip than throw "not iterable".
  if (!Array.isArray(HOTKEY_COMMANDS)) return;

  // Walk the rename table BEFORE the main hydrate so renamed
  // commands inherit their old `settings.values` entry. Without
  // this, every rename silently loses every user's custom binding.
  applyMigrations(settings.values, MIGRATIONS);

  for (const cmd of HOTKEY_COMMANDS) {
    const key = settingKey(cmd.id);
    if (!(key in settings.values)) {
      // No persisted override → leave the map entry absent so
      // `getBinding` falls through to the catalogue default. This
      // keeps the map small (only customised rows are present) and
      // means resetting back to default truly "forgets" the override.
      delete hotkeys.bindings[cmd.id];
      continue;
    }
    const raw = settings.values[key];
    if (raw === null) {
      hotkeys.bindings[cmd.id] = null;
    } else if (typeof raw === 'string') {
      hotkeys.bindings[cmd.id] = canonicalize(raw);
    } else {
      delete hotkeys.bindings[cmd.id];
    }
  }

  // After hydration, warn about any effective binding (override or
  // default) that hits a chord the OS captures. Surfaces in the
  // devtools console at app start so power users can spot a binding
  // that "didn't fire" without having to dig through settings.
  // Iterates the catalogue rather than `hotkeys.bindings` so defaults
  // are covered too — the rare case where a catalogue author picks
  // an unfortunate default chord.
  for (const cmd of HOTKEY_COMMANDS) {
    const binding =
      cmd.id in hotkeys.bindings
        ? hotkeys.bindings[cmd.id]
        : cmd.defaultBinding;
    const reason = wellKnownConflict(binding);
    if (reason) {
      console.warn(
        `[hotkeys] ${cmd.id} bound to ${binding} — ${reason}; the shortcut may not fire.`
      );
    }
  }
}

/**
 * Read the active binding for a command.
 *
 * Lookup order:
 *
 *   1. If the user has touched this command (entry exists in the
 *      reactive map), return that value — whether it's a string or
 *      `null`. Explicit `null` means "user unset this", and the
 *      catalogue default is intentionally NOT a fallback in that
 *      case: unset must mean "no key", not "no key for now, then
 *      default again later".
 *
 *   2. Otherwise (entry missing — pre-hydrate or a command the user
 *      hasn't touched since install), return the catalogue default.
 *
 * Reading through this helper keeps the reactivity dependency targeted
 * at `hotkeys.bindings[commandId]` specifically — the toolbar's Bold
 * tooltip re-renders only when Bold's binding changes, not when any
 * other command changes.
 */
export function getBinding(commandId: string): string | null {
  const def = COMMAND_BY_ID[commandId];
  if (!def) return null;
  // Property access on the $state proxy. Tracking is per-key, so each
  // call wires up a dep on exactly this binding.
  if (commandId in hotkeys.bindings) {
    return hotkeys.bindings[commandId];
  }
  return def.defaultBinding;
}

/**
 * Update a binding. Mirrors the write through both the reactive
 * surface (`hotkeys.bindings`) and the settings store (persistence).
 *
 * Conflict handling: when `binding` is non-null and another command
 * already owns it, reject the write. This keeps collisions visible at
 * the edge where the user attempted them instead of silently clearing
 * the old owner.
 */
export class HotkeyBindingConflictError extends Error {
  constructor(
    public readonly commandId: string,
    public readonly conflictingCommandId: string,
    public readonly binding: string
  ) {
    super(
      `[hotkeys] ${binding} is already assigned to ${conflictingCommandId}`
    );
    this.name = 'HotkeyBindingConflictError';
  }
}

export async function setBinding(
  commandId: string,
  binding: string | null
): Promise<void> {
  const def = COMMAND_BY_ID[commandId];
  if (!def) return;

  const normalized = binding === null ? null : canonicalize(binding);
  if (binding !== null && normalized === null) {
    throw new Error(`[hotkeys] refused to store invalid binding: ${binding}`);
  }

  if (normalized !== null) {
    for (const other of HOTKEY_COMMANDS) {
      if (other.id === commandId) continue;
      if (getBinding(other.id) === normalized) {
        throw new HotkeyBindingConflictError(commandId, other.id, normalized);
      }
    }
  }

  hotkeys.bindings[commandId] = normalized;
  await setSettingValue(settingKey(commandId), normalized);
}

/** Restore a command's default binding. Goes through `setBinding` so
 *  the same conflict checks apply before the default lands. */
export async function resetBinding(commandId: string): Promise<void> {
  const def = COMMAND_BY_ID[commandId];
  if (!def) return;
  await setBinding(commandId, def.defaultBinding);
}

/** True when the user's binding differs from the catalogue default —
 *  used by the settings UI to draw the small "modified" dot next to
 *  custom rows. Goes through `getBinding` so the dot's reactivity
 *  surface matches what the chip actually displays. */
export function isCustomized(commandId: string): boolean {
  const def = COMMAND_BY_ID[commandId];
  if (!def) return false;
  return getBinding(commandId) !== def.defaultBinding;
}

/**
 * Reverse lookup: which command currently owns this binding, if any.
 * Used by the recorder UI to surface the conflict warning before the
 * user commits.
 *
 * Walks the small catalogue (under 50 entries) rather than caching a
 * reverse map — keeps the reactive dependency on `hotkeys.bindings`
 * via `getBinding` rather than on a derived cache that would need its
 * own invalidation.
 */
export function findCommandByBinding(
  binding: string
): CommandDefinition | null {
  for (const cmd of HOTKEY_COMMANDS) {
    if (getBinding(cmd.id) === binding) {
      return cmd;
    }
  }
  return null;
}
