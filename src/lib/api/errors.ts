/**
 * Turning anything thrown into something a human can read.
 *
 * Tauri command rejections do **not** arrive as `Error`s. Every command
 * returns `CommandResult<T>`, so a failure crosses the IPC boundary as a
 * serialized `CommandError` — a plain `{ code, message }` object. The
 * usual `err instanceof Error ? err.message : String(err)` idiom misses
 * that case and renders the useless `[object Object]`, which is exactly
 * what the "Sync now" button showed for an expired Etebase session.
 *
 * Prefer this helper over hand-rolled ternaries at any catch site that
 * can see a Tauri rejection.
 */

import type { CommandError } from './core';

/** True for the `{ code, message }` shape Tauri rejects commands with. */
export function isCommandError(err: unknown): err is CommandError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as Record<string, unknown>).code === 'string' &&
    typeof (err as Record<string, unknown>).message === 'string'
  );
}

/**
 * Extract a displayable message from an unknown throw. Order matters:
 * `CommandError` is checked before the generic object branch so we use
 * its `message` rather than falling through to `JSON.stringify`.
 */
export function toErrorMessage(err: unknown): string {
  if (isCommandError(err)) return err.message;
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const message = (err as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
    try {
      return JSON.stringify(err);
    } catch {
      // Cyclic or otherwise unserializable — fall through to String().
    }
  }
  return String(err);
}
