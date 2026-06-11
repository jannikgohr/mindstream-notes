/**
 * Filename and folder-name safety helpers for the notes-as-files
 * export. Two concerns:
 *
 *   1. Windows reserved characters (`< > : " / \ | ? *`), reserved
 *      device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9), and
 *      trailing dots / spaces. macOS and Linux are far more lenient,
 *      but we sanitise to the strictest common subset so the same
 *      export folder is portable across platforms.
 *
 *   2. Collisions inside a directory (two notes with the same title,
 *      sanitised-name match across kinds, etc.). The dedup helper
 *      appends `_2`, `_3`, ... until the name is free.
 */

const RESERVED_BASENAMES = new Set(
  [
    'CON',
    'PRN',
    'AUX',
    'NUL',
    'COM1',
    'COM2',
    'COM3',
    'COM4',
    'COM5',
    'COM6',
    'COM7',
    'COM8',
    'COM9',
    'LPT1',
    'LPT2',
    'LPT3',
    'LPT4',
    'LPT5',
    'LPT6',
    'LPT7',
    'LPT8',
    'LPT9'
  ].map((s) => s.toUpperCase())
);

// Windows-reserved chars + control bytes. Internal whitespace is
// preserved (then collapsed) so "Sprint planning" stays human-readable
// in the file tree.
const UNSAFE_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;

/**
 * Returns a string safe to use as a single filename component (no
 * separators). Drops leading/trailing whitespace and dots, replaces
 * unsafe chars with a single space and collapses runs of whitespace
 * so the result reads cleanly. Falls back to `Untitled` when input
 * is empty.
 *
 * Pass the desired max length (default 120). The cap leaves headroom
 * for the dedup suffix (`_<n>`) and the extension.
 */
export function sanitizeName(raw: string, maxLength = 120): string {
  let s = (raw ?? '').replace(UNSAFE_CHARS, ' ');
  // Collapse runs of whitespace so "a / b / c" becomes "a b c".
  s = s.replace(/\s+/g, ' ');
  s = s.trim();
  // Trailing dots confuse Windows (foo. → foo).
  s = s.replace(/\.+$/u, '').trim();
  // Reserved device names match case-insensitively against the basename
  // (i.e. ignoring the extension we haven't appended yet).
  if (RESERVED_BASENAMES.has(s.toUpperCase())) {
    s = `${s}_file`;
  }
  if (s.length > maxLength) s = s.slice(0, maxLength).trim();
  if (!s) s = 'Untitled';
  return s;
}

/**
 * Given a desired filename and the set of names already taken in the
 * same directory, return a non-colliding variant by appending `_2`,
 * `_3`, ... before the extension. Mutates `taken` by inserting the
 * chosen name so subsequent calls in the same directory dedup
 * naturally.
 */
export function dedupeAgainst(taken: Set<string>, desired: string): string {
  if (!taken.has(desired)) {
    taken.add(desired);
    return desired;
  }
  const dot = desired.lastIndexOf('.');
  const base = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : '';
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base}_${n}${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  // Astronomically unlikely; fall back to a uuid suffix so we never
  // return an unused name to the caller.
  const fallback = `${base}_${crypto.randomUUID()}${ext}`;
  taken.add(fallback);
  return fallback;
}
