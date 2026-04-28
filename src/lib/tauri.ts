/**
 * Typed bridge to the Rust backend.
 *
 * In production we go through `@tauri-apps/api`'s `invoke`. When the frontend
 * runs in a plain browser (e.g. `pnpm dev` without `tauri dev`) `invoke` will
 * throw because the IPC bridge isn't injected — we detect that and fall back
 * to an in-memory store so the UI still works.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';

export interface NotePayload {
  id: string;
  title: string;
  body: string;
}

export interface LoadedNote {
  id: string;
  title: string;
  body: string;
  modified: string;
}

const browserFallbackStore = new Map<string, LoadedNote>();

export function isTauri(): boolean {
  // Tauri v2 sets `window.__TAURI_INTERNALS__` when the IPC bridge is alive.
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Persist a note. Calls the Rust `save_note` command. */
export async function saveNote(note: NotePayload): Promise<void> {
  if (!isTauri()) {
    browserFallbackStore.set(note.id, {
      ...note,
      modified: new Date().toISOString()
    });
    console.info('[tauri-bridge] saveNote (browser fallback)', note.id);
    return;
  }
  await tauriInvoke<void>('save_note', { note });
}

/** Load a note by id. Calls the Rust `load_note` command. */
export async function loadNote(id: string): Promise<LoadedNote | null> {
  if (!isTauri()) {
    return browserFallbackStore.get(id) ?? null;
  }
  return await tauriInvoke<LoadedNote | null>('load_note', { id });
}

/** Optional: list known note ids. The Rust side currently returns []. */
export async function listNotes(): Promise<string[]> {
  if (!isTauri()) {
    return [...browserFallbackStore.keys()];
  }
  return await tauriInvoke<string[]>('list_notes');
}

/**
 * Open a note in a brand-new OS-level Tauri window. Calls the Rust
 * `open_note_window` command which uses WebviewWindowBuilder under the hood.
 *
 * Outside Tauri (`pnpm dev`) we fall back to `window.open(...)` — handy for
 * browser-only smoke tests; in a real browser this just opens a new tab.
 */
export async function openNoteWindow(id: string, title: string): Promise<void> {
  if (!isTauri()) {
    if (typeof window !== 'undefined') {
      window.open(
        `?window=editor&id=${encodeURIComponent(id)}`,
        '_blank',
        'noopener'
      );
    }
    return;
  }
  await tauriInvoke<void>('open_note_window', { id, title });
}
