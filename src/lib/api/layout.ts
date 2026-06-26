/**
 * Last-session dock layout. Stored in localStorage per vault/profile so
 * each vault reopens its own notes and split arrangement.
 *
 * The blob is whatever dockview's `dock.toJSON()` returns plus a small
 * meta header — we don't crack the dockview format ourselves, just round
 * it through. Saving is debounced; restore happens on Layout mount.
 */

const LEGACY_STORAGE_KEY = 'notes-app:dock-layout:v1';
const STORAGE_KEY_PREFIX = 'notes-app:dock-layout:v1:vault:';
const DEFAULT_VAULT_ID = 'default';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function validateSavedLayout(value: unknown): SavedLayout | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (!('dock' in value) || !isRecord(value.dock)) return null;
  if (value.activeNoteId !== null && typeof value.activeNoteId !== 'string') {
    return null;
  }
  if (typeof value.savedAt !== 'string') return null;
  return value as unknown as SavedLayout;
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
): void {
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

export function clearSavedLayout(vaultId = DEFAULT_VAULT_ID): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(storageKey(vaultId));
  if (vaultId === DEFAULT_VAULT_ID) localStorage.removeItem(LEGACY_STORAGE_KEY);
}
