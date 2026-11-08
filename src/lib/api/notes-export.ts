/**
 * Notes-as-files export bridge — mirror of `src-tauri/src/notes_export.rs`.
 *
 * The actual export loop lives in `$lib/notes-export/`. It picks the
 * folder here and writes through an export session (`./export-session`).
 */

import { assertString, isTauri, TauriCommandName, invokeTauri } from './core';

export async function pickExportDir(): Promise<string | null> {
  if (!isTauri()) return null;
  return parseNullableString(
    await invokeTauri<unknown>(TauriCommandName.NotesExportPickDir)
  );
}

function parseNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return assertString(value, 'notes_export_pick_dir response');
}
