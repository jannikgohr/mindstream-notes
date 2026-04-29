/**
 * Window-management bridge. Spawning a fresh OS-level Tauri window is a
 * Rust-side responsibility (capabilities, asset URL, drag-drop config).
 */

import { invokeOrFallback } from './index';

export async function openNoteWindow(id: string, title: string): Promise<void> {
  return invokeOrFallback<void>(
    'open_note_window',
    { id, title },
    () => {
      if (typeof window !== 'undefined') {
        window.open(
          `?window=editor&id=${encodeURIComponent(id)}`,
          '_blank',
          'noopener'
        );
      }
    }
  );
}
