/**
 * Schema-driven settings store.
 *
 * Two storage layers sit behind a single reactive map:
 *
 *   1. **Scoped persistence** — vault settings (`scope: 'V'`) are stored
 *      under a per-vault key; device settings (`scope: 'D'`) stay in the
 *      existing app/device key. Account dynamic values such as
 *      `account.serverUrl` are also vault-scoped by prefix.
 *
 *   2. **Local-first cache** — every value (including binding-backed ones)
 *      lives in `settings.values`. Reads are synchronous so consumers like
 *      `sort.ts`, `tree.svelte.ts`, the dialog's `isVisible` / `isModified`
 *      helpers, and any `$derived` chain can stay simple.
 *
 *   3. **Bindings** (registry.svelte.ts) — for settings whose source of
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
import { getPlatform, matchesPlatformFilter } from '$lib/platform';
import type { Category, Section, SettingsSchema, Setting } from './types';

const DEVICE_STORAGE_KEY = 'notes-app:settings:v1';
const VAULT_STORAGE_KEY_PREFIX = 'notes-app:settings:v1:vault:';
const DEFAULT_VAULT_ID = 'default';

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

/**
 * Resolver for setting definitions that live outside the static schema —
 * currently plugin-contributed settings, keyed `plugins.<pluginId>.<id>`. The
 * plugins layer registers one at startup so the store can honour a plugin
 * setting's scope + default without importing the plugins layer itself (which
 * would couple the core store to it). Consulted only after the static schema.
 */
export type DynamicSettingResolver = (id: string) => Setting | undefined;
let dynamicSettingResolver: DynamicSettingResolver | null = null;

export function registerDynamicSettingResolver(
  resolver: DynamicSettingResolver | null
): void {
  dynamicSettingResolver = resolver;
}

/**
 * Storage for settings this store does not own.
 *
 * Plugin settings are persisted in the vault database, not `localStorage`,
 * because the backend passes them to scripts and has to be able to read them.
 * The plugins layer registers this at startup so the dialog, `isModified` and
 * every `$derived` chain keep working against one API without the core store
 * importing the plugins layer.
 *
 * `read` stays synchronous — the whole store is built on synchronous reads —
 * so an implementation is expected to keep its own cache.
 */
export interface ExternalSettingStore {
  owns: (id: string) => boolean;
  read: (id: string) => unknown;
  has: (id: string) => boolean;
  write: (id: string, value: unknown) => Promise<void>;
  clear: (id: string) => Promise<void>;
}
let externalStore: ExternalSettingStore | null = null;

export function registerExternalSettingStore(
  store: ExternalSettingStore | null
): void {
  externalStore = store;
}

/** Static schema first, then any dynamically-registered (plugin) setting. */
function settingDef(id: string): Setting | undefined {
  return BY_ID[id] ?? dynamicSettingResolver?.(id);
}

export function defaultForSetting(def: Setting): unknown {
  const platformDefaults = def.defaultByPlatform;
  const current = getPlatform();
  if (platformDefaults && current) {
    if (current in platformDefaults) return platformDefaults[current];
    if (
      ['windows', 'macos', 'linux', 'freebsd'].includes(current) &&
      'desktop' in platformDefaults
    ) {
      return platformDefaults.desktop;
    }
    if (['android', 'ios'].includes(current) && 'mobile' in platformDefaults) {
      return platformDefaults.mobile;
    }
  }
  return 'default' in def ? def.default : undefined;
}

let activeSettingsVaultId = DEFAULT_VAULT_ID;

function vaultStorageKey(vaultId: string): string {
  return `${VAULT_STORAGE_KEY_PREFIX}${vaultId}`;
}

function scopeForId(id: string): 'V' | 'D' {
  const def = settingDef(id);
  if (def) return def.scope;
  // The sign-in form owns account.serverUrl dynamically, outside schema.json.
  if (id.startsWith('account.')) return 'V';
  return 'D';
}

function isStoredSettingsRecord(
  value: unknown
): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseStoredSettings(
  raw: string
): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(raw);
  return isStoredSettingsRecord(parsed) ? parsed : null;
}

function readStorage(key: string): Record<string, unknown> | null {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(key);
    return raw ? parseStoredSettings(raw) : null;
  } catch {
    return null;
  }
}

function pickScoped(
  raw: Record<string, unknown> | null | undefined,
  scope: 'V' | 'D'
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(raw ?? {})) {
    if (scopeForId(id) === scope) picked[id] = value;
  }
  return picked;
}

function loadRaw(vaultId = activeSettingsVaultId): Record<string, unknown> {
  const deviceRaw = readStorage(DEVICE_STORAGE_KEY);
  const vaultRaw = readStorage(vaultStorageKey(vaultId));
  // Back-compat: the old single settings key contained both device and
  // vault values. Seed the default vault from it until a scoped vault key
  // exists; new/non-default vaults start from schema defaults.
  const legacyVaultRaw =
    vaultRaw === null && vaultId === DEFAULT_VAULT_ID ? deviceRaw : null;
  return {
    // Device bucket: only its device-scoped ids. This key historically also
    // held vault-scoped values (pre-scoping), so it stays filtered or those
    // would leak into every vault.
    ...pickScoped(deviceRaw, 'D'),
    // Vault bucket: loaded wholesale — a value's *bucket is its scope*.
    // `persistNow` only ever writes vault-scoped ids here, so everything present
    // belongs to this vault. We deliberately do NOT re-derive each id's scope
    // via `scopeForId` on read: a plugin's vault-scoped setting (e.g. the
    // Templates folder/tag) is loaded at startup *before* its plugin registers,
    // so `scopeForId` would misclassify it as device-scoped and drop it —
    // silently losing the value on every restart.
    ...(vaultRaw ?? legacyVaultRaw ?? {})
  };
}

interface SettingsState {
  values: Record<string, unknown>;
  /** Ids whose async binding write is currently in flight. */
  pending: SvelteSet<string>;
}

export const settings = $state<SettingsState>({
  values: loadRaw(activeSettingsVaultId),
  pending: new SvelteSet<string>()
});

export function setSettingsVaultId(id: string): void {
  const next = id || DEFAULT_VAULT_ID;
  if (next === activeSettingsVaultId) return;
  persistNow();
  activeSettingsVaultId = next;
  settings.values = loadRaw(activeSettingsVaultId);
  void hydrateSettings('startup');
}

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
  if (externalStore?.owns(id)) {
    if (externalStore.has(id)) return externalStore.read(id);
    const def = settingDef(id);
    return def ? defaultForSetting(def) : undefined;
  }
  if (id in settings.values) return settings.values[id];
  const def = settingDef(id);
  return def ? defaultForSetting(def) : undefined;
}

/** True when a value was explicitly loaded/saved, not just schema-defaulted. */
export function hasSettingValue(id: string): boolean {
  if (externalStore?.owns(id)) return externalStore.has(id);
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
  if (externalStore?.owns(id)) {
    await externalStore.write(id, value);
    return;
  }
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
  const def = settingDef(id);
  if (!def) return;
  if (externalStore?.owns(id)) {
    await externalStore.clear(id);
    return;
  }
  if ('default' in def || def.defaultByPlatform) {
    await setSettingValue(id, defaultForSetting(def));
    return;
  }
  delete settings.values[id];
  persist();
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistNow();
  }, 150);
}

function persistNow() {
  if (typeof localStorage === 'undefined') return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    // Don't persist binding-backed values — their source is canonical and
    // we'd just be shadowing it with a stale snapshot.
    const device: Record<string, unknown> = {};
    const vault: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(settings.values)) {
      if (id in SETTING_BINDINGS) continue;
      if (scopeForId(id) === 'V') vault[id] = value;
      else device[id] = value;
    }
    localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(device));
    localStorage.setItem(
      vaultStorageKey(activeSettingsVaultId),
      JSON.stringify(vault)
    );
  } catch (err) {
    console.warn('[settings] save failed', err);
  }
}

/** True if the current value differs from the schema default. */
export function isModified(id: string): boolean {
  const def = settingDef(id);
  if (!def) return false;
  return getSettingValue(id) !== defaultForSetting(def);
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
export const settingsDialog = $state<{
  open: boolean;
  /** A category id to jump to on open (deep-link), consumed by the dialog. */
  requestedCategory: string | null;
}>({ open: false, requestedCategory: null });
export function openSettings(category?: string) {
  // Refresh binding-backed values so the panel reflects any out-of-band
  // changes (autostart toggled from the OS, theme switched in another
  // window, …). Fire-and-forget — the cache update is reactive.
  void hydrateSettings('all');
  settingsDialog.requestedCategory = category ?? null;
  settingsDialog.open = true;
}
export function closeSettings() {
  settingsDialog.open = false;
}
