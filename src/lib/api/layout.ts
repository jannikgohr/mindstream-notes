import { isRecord } from '$lib/validation';
import { isTauri } from './core';
import { pushToast } from '$lib/components/toast.svelte';
import { tUi } from '$lib/settings/i18n.svelte';
/**
 * Last-session dock layout. Native builds use the vault settings document;
 * browser previews use per-vault localStorage buckets.
 *
 * The blob is whatever dockview's `dock.toJSON()` returns plus a small
 * meta header — we don't crack the dockview format ourselves, just round
 * it through. Saving is debounced; restore happens on Layout mount.
 */

const LEGACY_STORAGE_KEY = 'notes-app:dock-layout:v1';
const STORAGE_KEY_PREFIX = 'notes-app:dock-layout:v1:vault:';
const DEFAULT_VAULT_ID = 'default';

let nativeVaultId: string | null = null;
let nativeSavedLayout: SavedLayout | null = null;
let nativeWriter:
  | ((vaultId: string, layout: SavedLayout | null) => Promise<void>)
  | null = null;

export function registerNativeLayoutWriter(
  writer: (vaultId: string, layout: SavedLayout | null) => Promise<void>
): void {
  nativeWriter = writer;
}

export function applyNativeSavedLayout(vaultId: string, value: unknown): void {
  nativeVaultId = vaultId;
  nativeSavedLayout = validateSavedLayout(value);
}

export function legacyLayoutRaw(vaultId: string): string | null {
  const scoped = localStorage.getItem(storageKey(vaultId));
  return (
    scoped ??
    (vaultId === DEFAULT_VAULT_ID
      ? localStorage.getItem(LEGACY_STORAGE_KEY)
      : null)
  );
}

function writeNativeLayout(
  vaultId: string,
  value: SavedLayout | null
): Promise<void> {
  const task =
    nativeWriter && nativeVaultId === vaultId
      ? nativeWriter(vaultId, value)
      : Promise.reject(
          new Error('layout vault has not initialized or does not match')
        );
  void task.catch((err) => {
    console.warn('[layout] save failed', err);
    pushToast(tUi('preferences.saveFailed'), { variant: 'error' });
  });
  return task;
}

export interface SavedLayout {
  version: number;
  /** Result of dock.toJSON() — opaque dockview state. */
  dock: unknown;
  /** Active note id at the time of save (best-effort restore). */
  activeNoteId: string | null;
  /** When the layout was written, ISO string. */
  savedAt: string;
}

function storageKey(vaultId: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(vaultId || DEFAULT_VAULT_ID)}`;
}

function isIsoDateString(value: string): boolean {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

export function validateSavedLayout(value: unknown): SavedLayout | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (!('dock' in value) || !isRecord(value.dock)) return null;
  const activeNoteId = value.activeNoteId;
  if (activeNoteId !== null && typeof activeNoteId !== 'string') {
    return null;
  }
  const savedAt = value.savedAt;
  if (typeof savedAt !== 'string' || !isIsoDateString(savedAt)) return null;
  return {
    version: 1,
    dock: value.dock,
    activeNoteId,
    savedAt
  };
}

function readSavedLayout(key: string): SavedLayout | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return validateSavedLayout(JSON.parse(raw));
  } catch (err) {
    console.warn('[layout] load failed', err);
    return null;
  }
}

export function loadSavedLayout(
  vaultId = DEFAULT_VAULT_ID
): SavedLayout | null {
  if (isTauri())
    return nativeVaultId === vaultId && nativeSavedLayout
      ? structuredClone(nativeSavedLayout)
      : null;
  const saved = readSavedLayout(storageKey(vaultId));
  if (saved) return saved;
  // Back-compat: before profiles, the default vault used one device-wide key.
  if (vaultId === DEFAULT_VAULT_ID) return readSavedLayout(LEGACY_STORAGE_KEY);
  return null;
}

export function saveLayout(
  vaultId: string,
  dock: unknown,
  activeNoteId: string | null
): void | Promise<void> {
  if (isTauri()) {
    if (!isRecord(dock)) return;
    return writeNativeLayout(vaultId, {
      version: 1,
      dock: structuredClone(dock),
      activeNoteId,
      savedAt: new Date().toISOString()
    });
  }
  if (typeof localStorage === 'undefined') return;
  try {
    if (!isRecord(dock)) return;
    const blob: SavedLayout = {
      version: 1,
      dock,
      activeNoteId,
      savedAt: new Date().toISOString()
    };
    localStorage.setItem(storageKey(vaultId), JSON.stringify(blob));
  } catch (err) {
    console.warn('[layout] save failed', err);
  }
}

export function clearSavedLayout(
  vaultId = DEFAULT_VAULT_ID
): void | Promise<void> {
  if (isTauri()) return writeNativeLayout(vaultId, null);
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(storageKey(vaultId));
  if (vaultId === DEFAULT_VAULT_ID) localStorage.removeItem(LEGACY_STORAGE_KEY);
}
