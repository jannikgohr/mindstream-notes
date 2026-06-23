/**
 * Schema-driven settings store.
 *
 * Two storage layers sit behind a single reactive map:
 *
 *   1. **Local-first cache** — every value (including binding-backed ones)
 *      lives in `settings.values`. Reads are synchronous so consumers like
 *      `sort.ts`, `tree.svelte.ts`, the dialog's `isVisible` / `isModified`
 *      helpers, and any `$derived` chain can stay simple.
 *
 *   2. **Bindings** (registry.svelte.ts) — for settings whose source of
 *      truth lives elsewhere (Tauri autostart, mode-watcher, sidebar UI
 *      state, …). On startup we hydrate only bindings needed outside the
 *      dialog; on-demand bindings refresh when Settings opens. Writes go
 *      through `setSettingValue`, which optimistically updates the cache,
 *      awaits `binding.set()`, then re-reads to pick up whatever the source
 *      decided was the canonical value (autostart, for example, may silently
 *      fall back to `false` if the OS denies the permission).
 *
 * Pending writes are tracked so the UI can show a spinner — important for
 * the autostart toggle, which round-trips through Tauri IPC and isn't
 * instant.
 */

import { SvelteSet } from 'svelte/reactivity';
import schemaData from './schema.json';
import { SETTING_BINDINGS } from './registry.svelte';
import { matchesPlatformFilter } from '$lib/platform';
import type { Category, Section, SettingsSchema, Setting } from './types';

const STORAGE_KEY = 'notes-app:settings:v1';

export const SCHEMA = schemaData as unknown as SettingsSchema;

/** Flat list of every setting definition, in declaration order. */
export const ALL_SETTINGS: Setting[] = (() => {
  const flat: Setting[] = [];
  for (const cat of SCHEMA.categories) {
    for (const sec of cat.sections) {
      for (const s of sec.settings) flat.push(s);
    }
  }
  return flat;
})();

/** Map id -> Setting for quick lookups. */
export const BY_ID: Record<string, Setting> = Object.fromEntries(
  ALL_SETTINGS.map((s) => [s.id, s])
);

function loadRaw(): Record<string, unknown> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface SettingsState {
  values: Record<string, unknown>;
  /** Ids whose async binding write is currently in flight. */
  pending: SvelteSet<string>;
}

export const settings = $state<SettingsState>({
  values: loadRaw(),
  pending: new SvelteSet<string>()
});

/**
 * Pull binding-backed settings into the cache. Errors are logged and
 * swallowed so one busted binding (e.g. the autostart plugin missing on a
 * stripped-down build) doesn't poison the rest of the dialog.
 */
export async function hydrateSettings(
  scope: 'startup' | 'all' = 'startup'
): Promise<void> {
  await Promise.all(
    Object.entries(SETTING_BINDINGS).map(async ([id, binding]) => {
      if (scope === 'startup' && binding.hydrate === 'on-demand') return;
      try {
        settings.values[id] = await binding.get();
      } catch (err) {
        console.warn('[settings] hydrate failed for', id, err);
      }
    })
  );
}

/**
 * Refresh a single binding-backed setting from its source. Used by the
 * dialog on open so the value reflects any out-of-band change (e.g. the
 * user disabled autostart from the OS settings panel).
 */
export async function refreshSetting(id: string): Promise<void> {
  const binding = SETTING_BINDINGS[id];
  if (!binding) return;
  try {
    settings.values[id] = await binding.get();
  } catch (err) {
    console.warn('[settings] refresh failed for', id, err);
  }
}

// Kick off the initial hydration once at import time. Components shouldn't
// have to await this — they'll re-render when the cache populates.
void hydrateSettings('startup');

/**
 * Synchronous read: returns the cached value, falling back to the schema
 * default while a binding hasn't hydrated yet. Stays sync so `$derived`
 * chains, `isVisible`, and non-component consumers (sort.ts, tree.svelte.ts)
 * don't have to thread Promises.
 */
export function getSettingValue(id: string): unknown {
  if (id in settings.values) return settings.values[id];
  const def = BY_ID[id];
  return def && 'default' in def ? def.default : undefined;
}

/** True when a value was explicitly loaded/saved, not just schema-defaulted. */
export function hasSettingValue(id: string): boolean {
  return id in settings.values;
}

/**
 * Async write: for binding-backed settings, updates the cache
 * optimistically, awaits the binding's `set()`, then re-reads from the
 * binding to pick up whatever value actually stuck. Rolls back the cache
 * if the binding throws so a failed Tauri call doesn't leave the UI lying.
 */
export async function setSettingValue(
  id: string,
  value: unknown
): Promise<void> {
  const binding = SETTING_BINDINGS[id];
  if (binding) {
    const prev = settings.values[id];
    settings.values[id] = value;
    settings.pending.add(id);
    try {
      await binding.set(value);
      // Re-read so we reflect any transformation the source did (autostart
      // can silently end up disabled if the OS denies permission, etc.).
      try {
        settings.values[id] = await binding.get();
      } catch {
        /* fall through with optimistic value */
      }
    } catch (err) {
      console.error('[settings] write failed for', id, err);
      settings.values[id] = prev;
      throw err;
    } finally {
      settings.pending.delete(id);
    }
    return;
  }
  settings.values[id] = value;
  persist();
}

export async function resetSettingValue(id: string): Promise<void> {
  const def = BY_ID[id];
  if (!def) return;
  if ('default' in def) {
    await setSettingValue(id, def.default);
    return;
  }
  delete settings.values[id];
  persist();
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      // Don't persist binding-backed values — their source is canonical and
      // we'd just be shadowing it with a stale snapshot.
      const persisted: Record<string, unknown> = {};
      for (const [id, v] of Object.entries(settings.values)) {
        if (id in SETTING_BINDINGS) continue;
        persisted[id] = v;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch (err) {
      console.warn('[settings] save failed', err);
    }
  }, 150);
}

/** True if the current value differs from the schema default. */
export function isModified(id: string): boolean {
  const def = BY_ID[id];
  if (!def) return false;
  if (!('default' in def)) return false;
  return getSettingValue(id) !== def.default;
}

/** True while a binding write for this id is in flight. */
export function isPending(id: string): boolean {
  return settings.pending.has(id);
}

/** Resolve showIf against the live store. Recursive showIf isn't supported. */
export function isVisible(setting: Setting): boolean {
  if (!matchesPlatformFilter(setting.platforms)) return false;
  const cond = setting.showIf;
  if (!cond) return true;
  const v = getSettingValue(cond.id);
  if ('equals' in cond && cond.equals !== undefined) return v === cond.equals;
  if ('notEquals' in cond && cond.notEquals !== undefined)
    return v !== cond.notEquals;
  if ('in' in cond && Array.isArray(cond.in)) return cond.in.includes(v);
  return true;
}

/** True if the section's `platforms` filter (if any) matches the current OS. */
export function isSectionVisible(section: Section): boolean {
  return matchesPlatformFilter(section.platforms);
}

/** True if the category's `platforms` filter (if any) matches the current OS. */
export function isCategoryVisible(category: Category): boolean {
  return matchesPlatformFilter(category.platforms);
}

/** Open/close state for the dialog itself. */
export const settingsDialog = $state({ open: false });
export function openSettings() {
  // Refresh binding-backed values so the panel reflects any out-of-band
  // changes (autostart toggled from the OS, theme switched in another
  // window, …). Fire-and-forget — the cache update is reactive.
  void hydrateSettings('all');
  settingsDialog.open = true;
}
export function closeSettings() {
  settingsDialog.open = false;
}
