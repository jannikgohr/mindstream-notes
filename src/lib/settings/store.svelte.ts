/**
 * Schema-driven settings store. Each setting is keyed by id; the value
 * either lives in localStorage (default) or is delegated to a binding
 * registered in registry.ts.
 */

import schemaData from './schema.json';
import { SETTING_BINDINGS } from './registry.svelte';
import type { SettingsSchema, Setting } from './types';

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

const initial = loadRaw();

export const settings = $state<{ values: Record<string, unknown> }>({
  values: initial
});

/** Get a setting's current value: binding → store → schema default. */
export function getSettingValue(id: string): unknown {
  const binding = SETTING_BINDINGS[id];
  if (binding) return binding.get();
  if (id in settings.values) return settings.values[id];
  const def = BY_ID[id];
  return def && 'default' in def ? def.default : undefined;
}

export function setSettingValue(id: string, value: unknown) {
  const binding = SETTING_BINDINGS[id];
  if (binding) {
    binding.set(value);
    return;
  }
  settings.values[id] = value;
  persist();
}

export function resetSettingValue(id: string) {
  const def = BY_ID[id];
  if (!def) return;
  if ('default' in def) setSettingValue(id, def.default);
  else delete settings.values[id];
  persist();
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings.values));
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

/** Resolve showIf against the live store. Recursive showIf isn't supported. */
export function isVisible(setting: Setting): boolean {
  const cond = setting.showIf;
  if (!cond) return true;
  const v = getSettingValue(cond.id);
  if ('equals' in cond && cond.equals !== undefined) return v === cond.equals;
  if ('notEquals' in cond && cond.notEquals !== undefined) return v !== cond.notEquals;
  if ('in' in cond && Array.isArray(cond.in)) return cond.in.includes(v);
  return true;
}

/** Open/close state for the dialog itself. */
export const settingsDialog = $state({ open: false });
export function openSettings() {
  settingsDialog.open = true;
}
export function closeSettings() {
  settingsDialog.open = false;
}
