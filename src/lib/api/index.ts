/**
 * Typed bridges to the Rust backend, organised by domain.
 *
 * All Tauri command shapes here mirror the serde types in src-tauri/src/.
 * In the browser fallback (`pnpm dev` outside Tauri) calls hit a small
 * in-memory store seeded with the same demo content the Rust seed inserts,
 * so the UI works for smoke tests without spinning up Tauri.
 */

export * from './core';
export * from './notes';
export * from './search';
export * from './pdf-text';
export * from './history';
export * from './content-stats';
export * from './assets';
export * from './collections';
export * from './drawing';
export * from './tree';
export * from './layout';
export * from './window';
export * from './auth.svelte';
export * from './sync';
export * from './system';
export * from './desktop-settings';
export * from './profiles';
export * from './hotkeys';
export * from './server-urls';
export { pickExportDir, writeExportFile } from './notes-export';
export {
  openDataFolder,
  openFolder,
  trashCounts,
  emptyTrash as emptyTrashCmd,
  setTrashRetention,
  sweepTrashRetention,
  backupNow,
  importBegin,
  importCleanup,
  importRestore,
  importMerge,
  type TrashCounts,
  type BackupCounts,
  type BackupReport,
  type AccountDisplay,
  type ImportPreview,
  type RestoreStaged,
  type MergeReport
} from './data';

/** Reserved id for the always-present trash collection (mirrors Rust). */
export const TRASH_ID = 'trash';
