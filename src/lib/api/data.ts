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
import {
  assertBoolean,
  assertNumber,
  assertRecord,
  assertString,
  assertVoid,
  isTauri,
  optionalString
} from './core';
import { mockApi } from './mock-store';

export interface TrashCounts {
  notes: number;
  folders: number;
}

export async function openDataFolder(): Promise<void> {
  if (!isTauri()) return;
  assertVoid(
    await tauriInvoke<unknown>('open_data_folder'),
    'open_data_folder response'
  );
}

/**
 * Reveal an arbitrary directory in the OS file manager. Used by the
 * export-result dialog's "Open location" button — the path here came
 * from `pickExportDir()`, so it's already user-chosen.
 */
export async function openFolder(path: string): Promise<void> {
  assertRequiredString(path, 'path');
  if (!isTauri()) return;
  assertVoid(
    await tauriInvoke<unknown>('open_folder', { path }),
    'open_folder response'
  );
}

export async function trashCounts(): Promise<TrashCounts> {
  if (!isTauri()) return await mockApi.trashCounts();
  return parseTrashCounts(await tauriInvoke<unknown>('trash_counts'));
}

export async function emptyTrash(): Promise<TrashCounts> {
  if (!isTauri()) return await mockApi.emptyTrash();
  return parseTrashCounts(await tauriInvoke<unknown>('empty_trash'));
}

/**
 * Tell the Rust scheduler the current retention preference.
 * `days = 0` disables the sweep (used for the "Forever" option).
 * No-op outside Tauri.
 */
export async function setTrashRetention(days: number): Promise<void> {
  assertNonNegativeInteger(days, 'days');
  if (!isTauri()) return;
  assertVoid(
    await tauriInvoke<unknown>('set_trash_retention', { days }),
    'set_trash_retention response'
  );
}

/**
 * Run the retention sweep right now. Returns how many top-level
 * trash items were aged out. The settings effect calls this on
 * startup so the user doesn't have to wait up to an hour for the
 * first scheduled tick to fire.
 */
export async function sweepTrashRetention(days: number): Promise<number> {
  assertNonNegativeInteger(days, 'days');
  if (!isTauri()) return 0;
  return assertNumber(
    await tauriInvoke<unknown>('sweep_trash_retention', { days }),
    'sweep_trash_retention response'
  );
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
  return parseNullableBackupReport(await tauriInvoke<unknown>('backup_now'));
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
  return parseNullableImportPreview(await tauriInvoke<unknown>('import_begin'));
}

/** Drop the staging dir created by `importBegin`. Safe on stale tokens. */
export async function importCleanup(token: string): Promise<void> {
  assertRequiredString(token, 'token');
  if (!isTauri()) return;
  assertVoid(
    await tauriInvoke<unknown>('import_cleanup', { token }),
    'import_cleanup response'
  );
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
  assertRequiredString(token, 'token');
  if (typeof sameAccount !== 'boolean') {
    throw new Error('sameAccount must be a boolean');
  }
  if (!isTauri()) return { restart_required: false, sanitized: !sameAccount };
  return parseRestoreStaged(
    await tauriInvoke<unknown>('import_restore', {
      token,
      sameAccount
    })
  );
}

/**
 * In-process merge: copy missing items from the staged DB into the
 * live one. No restart needed. Sync metadata is always stripped.
 */
export async function importMerge(token: string): Promise<MergeReport> {
  assertRequiredString(token, 'token');
  if (!isTauri())
    return {
      folders_added: 0,
      notes_added: 0,
      assets_added: 0,
      notes_orphaned: 0
    };
  return parseMergeReport(
    await tauriInvoke<unknown>('import_merge', { token })
  );
}

function assertRequiredString(value: string, context: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
}

function assertNonNegativeInteger(value: number, context: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${context} must be a non-negative integer`);
  }
}

function parseTrashCounts(value: unknown): TrashCounts {
  const raw = assertRecord(value, 'trash counts');
  return {
    notes: assertNumber(raw.notes, 'trash counts.notes'),
    folders: assertNumber(raw.folders, 'trash counts.folders')
  };
}

function parseBackupCounts(value: unknown, context: string): BackupCounts {
  const raw = assertRecord(value, context);
  return {
    notes: assertNumber(raw.notes, `${context}.notes`),
    folders: assertNumber(raw.folders, `${context}.folders`),
    assets_bytes: assertNumber(raw.assets_bytes, `${context}.assets_bytes`)
  };
}

function parseBackupReport(value: unknown): BackupReport {
  const raw = assertRecord(value, 'backup report');
  return {
    destination: assertString(raw.destination, 'backup report.destination'),
    counts: parseBackupCounts(raw.counts, 'backup report.counts'),
    account_present: assertBoolean(
      raw.account_present,
      'backup report.account_present'
    )
  };
}

function parseNullableBackupReport(value: unknown): BackupReport | null {
  if (value === null || value === undefined) return null;
  return parseBackupReport(value);
}

function parseAccountDisplay(value: unknown, context: string): AccountDisplay {
  const raw = assertRecord(value, context);
  return {
    username: optionalString(raw.username, `${context}.username`),
    server_url: optionalString(raw.server_url, `${context}.server_url`)
  };
}

function parseNullableAccountDisplay(
  value: unknown,
  context: string
): AccountDisplay | null {
  if (value === null || value === undefined) return null;
  return parseAccountDisplay(value, context);
}

function parseImportPreview(value: unknown): ImportPreview {
  const raw = assertRecord(value, 'import preview');
  return {
    token: assertString(raw.token, 'import preview.token'),
    backup_counts: parseBackupCounts(
      raw.backup_counts,
      'import preview.backup_counts'
    ),
    current_counts: parseBackupCounts(
      raw.current_counts,
      'import preview.current_counts'
    ),
    backup_app_version: assertString(
      raw.backup_app_version,
      'import preview.backup_app_version'
    ),
    backup_created_at: assertString(
      raw.backup_created_at,
      'import preview.backup_created_at'
    ),
    same_account: assertBoolean(
      raw.same_account,
      'import preview.same_account'
    ),
    backup_account: parseNullableAccountDisplay(
      raw.backup_account,
      'import preview.backup_account'
    ),
    current_account: parseNullableAccountDisplay(
      raw.current_account,
      'import preview.current_account'
    )
  };
}

function parseNullableImportPreview(value: unknown): ImportPreview | null {
  if (value === null || value === undefined) return null;
  return parseImportPreview(value);
}

function parseRestoreStaged(value: unknown): RestoreStaged {
  const raw = assertRecord(value, 'restore staged');
  return {
    restart_required: assertBoolean(
      raw.restart_required,
      'restore staged.restart_required'
    ),
    sanitized: assertBoolean(raw.sanitized, 'restore staged.sanitized')
  };
}

function parseMergeReport(value: unknown): MergeReport {
  const raw = assertRecord(value, 'merge report');
  return {
    folders_added: assertNumber(
      raw.folders_added,
      'merge report.folders_added'
    ),
    notes_added: assertNumber(raw.notes_added, 'merge report.notes_added'),
    assets_added: assertNumber(raw.assets_added, 'merge report.assets_added'),
    notes_orphaned: assertNumber(
      raw.notes_orphaned,
      'merge report.notes_orphaned'
    )
  };
}
