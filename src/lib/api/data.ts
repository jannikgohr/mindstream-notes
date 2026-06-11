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

// ---------- Backup export (Slice A) ----------

export interface BackupCounts {
  notes: number;
  folders: number;
  assets_bytes: number;
}

export interface BackupReport {
  destination: string;
  counts: BackupCounts;
  account_present: boolean;
}

/**
 * Pop the Save-As dialog (defaults to `<app_data>/backups/`), then
 * run the export to whatever path the user picks. Returns `null` if
 * the user cancelled the dialog — the caller should stay quiet in
 * that case, not surface a "backup failed" toast.
 */
export async function backupNow(): Promise<BackupReport | null> {
  if (!isTauri()) return null;
  return await tauriInvoke<BackupReport | null>('backup_now');
}

// ---------- Backup import (Slices B/C/D) ----------

export interface AccountDisplay {
  username: string | null;
  server_url: string | null;
}

export interface ImportPreview {
  token: string;
  backup_counts: BackupCounts;
  current_counts: BackupCounts;
  backup_app_version: string;
  backup_created_at: string;
  same_account: boolean;
  backup_account: AccountDisplay | null;
  current_account: AccountDisplay | null;
}

export interface RestoreStaged {
  restart_required: boolean;
  sanitized: boolean;
}

export interface MergeReport {
  folders_added: number;
  notes_added: number;
  assets_added: number;
  notes_orphaned: number;
}

/**
 * Pop the file picker for a backup zip; extract + validate + return a
 * preview struct. `null` means the user cancelled the picker.
 */
export async function importBegin(): Promise<ImportPreview | null> {
  if (!isTauri()) return null;
  return await tauriInvoke<ImportPreview | null>('import_begin');
}

/** Drop the staging dir created by `importBegin`. Safe on stale tokens. */
export async function importCleanup(token: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>('import_cleanup', { token });
}

/**
 * Stage a replace-all restore. The Rust side moves the staged DB
 * into pending-restore.db and writes the sentinel; the app needs a
 * relaunch to actually swap the files in.
 */
export async function importRestore(
  token: string,
  sameAccount: boolean
): Promise<RestoreStaged> {
  if (!isTauri()) return { restart_required: false, sanitized: !sameAccount };
  return await tauriInvoke<RestoreStaged>('import_restore', {
    token,
    sameAccount
  });
}

/**
 * In-process merge: copy missing items from the staged DB into the
 * live one. No restart needed. Sync metadata is always stripped.
 */
export async function importMerge(token: string): Promise<MergeReport> {
  if (!isTauri())
    return {
      folders_added: 0,
      notes_added: 0,
      assets_added: 0,
      notes_orphaned: 0
    };
  return await tauriInvoke<MergeReport>('import_merge', { token });
}
