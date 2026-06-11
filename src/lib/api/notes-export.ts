/**
 * Notes-as-files export bridge — mirror of `src-tauri/src/notes_export.rs`.
 *
 * The actual export loop lives in `$lib/notes-export/` and drives the
 * Rust side via these two calls:
 *   - pickExportDir  → folder picker; returns chosen path or null
 *   - writeExportFile → write bytes under the chosen root with a
 *                       path-traversal guard
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { isTauri } from './index';

export async function pickExportDir(): Promise<string | null> {
  if (!isTauri()) return null;
  return await tauriInvoke<string | null>('notes_export_pick_dir');
}

export async function writeExportFile(
  root: string,
  relativePath: string,
  bytes: Uint8Array
): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>('notes_export_write_file', {
    root,
    relativePath,
    // Tauri marshalling of Vec<u8> expects a JS number array. Most
    // call sites already build a Uint8Array (TextEncoder output, asset
    // bytes), so do the conversion here once.
    bytes: Array.from(bytes)
  });
}
