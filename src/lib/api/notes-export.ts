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
import { assertString, assertVoid, isTauri } from './core';

export async function pickExportDir(): Promise<string | null> {
  if (!isTauri()) return null;
  return parseNullableString(
    await tauriInvoke<unknown>('notes_export_pick_dir')
  );
}

export async function writeExportFile(
  root: string,
  relativePath: string,
  bytes: Uint8Array
): Promise<void> {
  assertRequiredString(root, 'root');
  assertRequiredString(relativePath, 'relativePath');
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('bytes must be a Uint8Array');
  }
  if (!isTauri()) return;
  assertVoid(
    await tauriInvoke<unknown>('notes_export_write_file', {
      root,
      relativePath,
      // Tauri marshalling of Vec<u8> expects a JS number array. Most
      // call sites already build a Uint8Array (TextEncoder output, asset
      // bytes), so do the conversion here once.
      bytes: Array.from(bytes)
    }),
    'notes_export_write_file response'
  );
}

function assertRequiredString(value: string, context: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
}

function parseNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return assertString(value, 'notes_export_pick_dir response');
}
