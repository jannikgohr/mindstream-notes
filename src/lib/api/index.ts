/**
 * Typed bridges to the Rust backend, organised by domain.
 *
 * All Tauri command shapes here mirror the serde types in src-tauri/src/.
 * In the browser fallback (`pnpm dev` outside Tauri) calls hit a small
 * in-memory store seeded with the same demo content the Rust seed inserts,
 * so the UI works for smoke tests without spinning up Tauri.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function invokeOrFallback<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  fallback: () => T | Promise<T>
): Promise<T> {
  if (!isTauri()) return await fallback();
  return await tauriInvoke<T>(command, args);
}

export * from './notes';
export * from './search';
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
export * from './hotkeys';
export * from './server-urls';
export {
  openDataFolder,
  trashCounts,
  emptyTrash as emptyTrashCmd,
  type TrashCounts
} from './data';

/** Reserved id for the always-present trash collection (mirrors Rust). */
export const TRASH_ID = 'trash';
