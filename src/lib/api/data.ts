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
