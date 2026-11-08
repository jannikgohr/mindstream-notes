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
// Stripping C0 control bytes out of a filename is what this regex is for.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;

/** File systems cap a name at 255 bytes, not characters. This leaves room
 *  for a dedup suffix and the longest extension the export appends. */
const MAX_NAME_BYTES = 200;
const utf8 = new TextEncoder();

/**
 * Returns a string safe to use as a single filename component (no
 * separators). Drops leading/trailing whitespace and dots, replaces
 * unsafe chars with a single space and collapses runs of whitespace
 * so the result reads cleanly. Falls back to `Untitled` when input
 * is empty.
 *
 * Pass the desired max length in characters (default 120). The result
 * also stays within {@link MAX_NAME_BYTES} of UTF-8, which leaves
 * headroom for the dedup suffix (`_<n>`) and the extension.
 */
export function sanitizeName(raw: string, maxLength = 120): string {
  let s = (raw ?? '').replace(UNSAFE_CHARS, ' ');
  // Collapse runs of whitespace so "a / b / c" becomes "a b c".
  s = s.replace(/\s+/g, ' ');
  s = truncate(s.trim(), maxLength);
  // Trailing dots confuse Windows (foo. → foo).
  s = s.replace(/\.+$/u, '').trim();
  if (!s) return 'Untitled';
  // Windows reserves a device name whatever follows its first dot, so
  // `CON.txt` is as unusable as `CON`. Matched case-insensitively.
  const dot = s.indexOf('.');
  const stem = dot < 0 ? s : s.slice(0, dot);
  if (RESERVED_BASENAMES.has(stem.trim().toUpperCase())) {
    s = `${stem}_file${dot < 0 ? '' : s.slice(dot)}`;
  }
  return s;
}

/** The longest prefix within `maxLength` characters and
 *  {@link MAX_NAME_BYTES} bytes, never splitting a character. */
function truncate(s: string, maxLength: number): string {
  let out = '';
  let bytes = 0;
  for (const char of s) {
    bytes += utf8.encode(char).length;
    if (out.length + char.length > maxLength || bytes > MAX_NAME_BYTES) break;
    out += char;
  }
  return out.trim();
}

/** Windows and macOS ignore case, and macOS Unicode normalisation too, so
 *  names that differ only there would land on the same file. */
function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * Given a desired filename and the set of names already taken in the
 * same directory, return a non-colliding variant by appending `_2`,
 * `_3`, ... before the extension. Mutates `taken` by inserting the
 * chosen name so subsequent calls in the same directory dedup
 * naturally. Names that differ only in case or Unicode normalisation
 * count as the same name. `taken` holds them in that folded form, so
 * only this function should add to it.
 */
export function dedupeAgainst(taken: Set<string>, desired: string): string {
  if (!taken.has(nameKey(desired))) {
    taken.add(nameKey(desired));
    return desired;
  }
  const dot = desired.lastIndexOf('.');
  const base = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : '';
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base}_${n}${ext}`;
    if (!taken.has(nameKey(candidate))) {
      taken.add(nameKey(candidate));
      return candidate;
    }
  }
  // Astronomically unlikely; fall back to a uuid suffix so we never
  // return an unused name to the caller.
  const fallback = `${base}_${crypto.randomUUID()}${ext}`;
  taken.add(nameKey(fallback));
  return fallback;
}
