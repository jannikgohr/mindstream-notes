/**
 * Last-session dock layout. Stored in localStorage (per-device) so
 * popout windows / multi-vault setups don't fight over the same key.
 *
 * The blob is whatever dockview's `dock.toJSON()` returns plus a small
 * meta header — we don't crack the dockview format ourselves, just round
 * it through. Saving is debounced; restore happens on Layout mount.
 */

const STORAGE_KEY = 'notes-app:dock-layout:v1';

export interface SavedLayout {
  version: number;
  /** Result of dock.toJSON() — opaque dockview state. */
  dock: unknown;
  /** Active note id at the time of save (best-effort restore). */
  activeNoteId: string | null;
  /** When the layout was written, ISO string. */
  savedAt: string;
}

export function loadSavedLayout(): SavedLayout | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedLayout;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn('[layout] load failed', err);
    return null;
  }
}

export function saveLayout(dock: unknown, activeNoteId: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const blob: SavedLayout = {
      version: 1,
      dock,
      activeNoteId,
      savedAt: new Date().toISOString()
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
  } catch (err) {
    console.warn('[layout] save failed', err);
  }
}

export function clearSavedLayout(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}
