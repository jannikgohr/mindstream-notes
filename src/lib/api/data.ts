/**
 * Data & Backup bridge — mirrors src-tauri/src/data.rs.
 *
 * Currently three calls:
 *   - openDataFolder: reveal the app data dir in the OS file manager
 *   - trashCounts:    how many notes/folders the trash holds (recursive)
 *   - emptyTrash:     purge every item under the trash collection
 *
 * The browser fallbacks are no-ops / empty counts so the dev preview
 * doesn't crash when these calls land outside Tauri.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { isTauri } from './index';

export interface TrashCounts {
  notes: number;
  folders: number;
}

export async function openDataFolder(): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>('open_data_folder');
}

export async function trashCounts(): Promise<TrashCounts> {
  if (!isTauri()) return { notes: 0, folders: 0 };
  return await tauriInvoke<TrashCounts>('trash_counts');
}

export async function emptyTrash(): Promise<TrashCounts> {
  if (!isTauri()) return { notes: 0, folders: 0 };
  return await tauriInvoke<TrashCounts>('empty_trash');
}

/**
 * Tell the Rust scheduler the current retention preference.
 * `days = 0` disables the sweep (used for both the "Forever" option
 * and `data.useTrash = false`). No-op outside Tauri.
 */
export async function setTrashRetention(days: number): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>('set_trash_retention', { days });
}

/**
 * Run the retention sweep right now. Returns how many top-level
 * trash items were aged out. The settings effect calls this on
 * startup so the user doesn't have to wait up to an hour for the
 * first scheduled tick to fire.
 */
export async function sweepTrashRetention(days: number): Promise<number> {
  if (!isTauri()) return 0;
  return await tauriInvoke<number>('sweep_trash_retention', { days });
}
