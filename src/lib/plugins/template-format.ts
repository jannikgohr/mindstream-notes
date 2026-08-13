/**
 * The declarative "helper tier" of the template language — a bounded, pure,
 * dependency-free expression evaluator that gives plugin templates most of what
 * Obsidian's Templater offers *without* a code runtime.
 *
 * Everything here is data-in → string-out. There is no scripting VM, no I/O, no
 * loops a template can drive, and no function calls a template can name beyond
 * the fixed vocabulary below — so the manifest-only security model (a plugin
 * ships strings, the app interprets them) is fully preserved.
 *
 * A placeholder is `{{ base [offset] [":" format] [ "|" filter ]* }}`:
 *
 *   - `base`      an identifier: a template variable, or a built-in date key
 *                 (`date`, `time`, `datetime`, `now`) or `uuid`.
 *   - `offset`    date math on a date base, chainable: `+7d`, `-1M`, `+2w-1d`.
 *                 Units: `y` year, `M` month, `w` week, `d` day, `h` hour,
 *                 `m` minute, `s` second (moment's case convention: `M` month,
 *                 `m` minute).
 *   - `format`    a moment-style token string for a date base, e.g.
 *                 `YYYY-MM-DD`, `dddd`, `HH:mm`. Locale-aware names come from
 *                 `Intl` using the caller-supplied locale.
 *   - `filter`    a text transform applied last: `upper`, `lower`, `trim`,
 *                 `capitalize`, `slug`. Unknown filters are a no-op.
 *
 * This module is intentionally locale-*pure*: the active app language is passed
 * in as `locale`, never read here, so the whole engine is trivially testable.
 */

/** Built-in date bases and the default format each renders with, absent `:`. */
const DATE_DEFAULT_FORMAT: Record<string, string> = {
  date: 'YYYY-MM-DD',
  time: 'HH:mm',
  datetime: 'YYYY-MM-DD HH:mm',
  now: 'YYYY-MM-DD HH:mm'
};

/** True when `base` names a built-in date key (offset/format capable). */
export function isDateBase(base: string): boolean {
  return Object.prototype.hasOwnProperty.call(DATE_DEFAULT_FORMAT, base);
}

/** The default format for a date base (used when a placeholder omits `:`). */
export function defaultDateFormat(base: string): string {
  return DATE_DEFAULT_FORMAT[base] ?? 'YYYY-MM-DD';
}

const OFFSET_TERM_RE = /([+-]\d+)([yMwdhms])/g;

/**
 * Apply a chained offset string (`+7d-1M`) to `date`, returning a new Date.
 * Unrecognised input applies nothing (the base date is returned unchanged),
 * matching the engine's lenient "degrade, don't throw" stance.
 */
export function applyDateOffset(date: Date, offset: string): Date {
  const out = new Date(date.getTime());
  if (!offset) return out;
  for (const [, amountStr, unit] of offset.matchAll(OFFSET_TERM_RE)) {
    const n = Number(amountStr);
    switch (unit) {
      case 'y':
        out.setFullYear(out.getFullYear() + n);
        break;
      case 'M':
        out.setMonth(out.getMonth() + n);
        break;
      case 'w':
        out.setDate(out.getDate() + n * 7);
        break;
      case 'd':
        out.setDate(out.getDate() + n);
        break;
      case 'h':
        out.setHours(out.getHours() + n);
        break;
      case 'm':
        out.setMinutes(out.getMinutes() + n);
        break;
      case 's':
        out.setSeconds(out.getSeconds() + n);
        break;
    }
  }
  return out;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** A locale-named month/weekday part, e.g. `MMMM`→"July"/"Juli". */
function intlName(
  date: Date,
  locale: string,
  opt: Intl.DateTimeFormatOptions
): string {
  try {
    return new Intl.DateTimeFormat(locale || 'en', opt).format(date);
  } catch {
    return new Intl.DateTimeFormat('en', opt).format(date);
  }
}

// Longest tokens first so `MMMM` wins over `MMM`/`MM`/`M`. `[...]` escapes a
// literal (moment convention) so a format can contain reserved letters.
const FORMAT_TOKEN_RE =
  /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|A|a/g;

/**
 * Format `date` with a moment-style `format` string. Named parts (month,
 * weekday) are localized via `locale`; numeric parts are locale-independent.
 * Unknown characters pass through literally.
 */
export function formatDate(date: Date, format: string, locale = 'en'): string {
  const hours24 = date.getHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return format.replace(FORMAT_TOKEN_RE, (match, literal?: string) => {
    if (literal !== undefined) return literal;
    switch (match) {
      case 'YYYY':
        return String(date.getFullYear());
      case 'YY':
        return pad2(date.getFullYear() % 100);
      case 'MMMM':
        return intlName(date, locale, { month: 'long' });
      case 'MMM':
        return intlName(date, locale, { month: 'short' });
      case 'MM':
        return pad2(date.getMonth() + 1);
      case 'M':
        return String(date.getMonth() + 1);
      case 'DD':
        return pad2(date.getDate());
      case 'D':
        return String(date.getDate());
      case 'dddd':
        return intlName(date, locale, { weekday: 'long' });
      case 'ddd':
        return intlName(date, locale, { weekday: 'short' });
      case 'HH':
        return pad2(hours24);
      case 'H':
        return String(hours24);
      case 'hh':
        return pad2(hours12);
      case 'h':
        return String(hours12);
      case 'mm':
        return pad2(date.getMinutes());
      case 'm':
        return String(date.getMinutes());
      case 'ss':
        return pad2(date.getSeconds());
      case 's':
        return String(date.getSeconds());
      case 'A':
        return hours24 < 12 ? 'AM' : 'PM';
      case 'a':
        return hours24 < 12 ? 'am' : 'pm';
      default:
        return match;
    }
  });
}

/** Apply a single named text filter. An unknown name is a no-op. */
export function applyFilter(value: string, name: string): string {
  switch (name) {
    case 'upper':
      return value.toUpperCase();
    case 'lower':
      return value.toLowerCase();
    case 'trim':
      return value.trim();
    case 'capitalize':
      return value.length ? value[0].toUpperCase() + value.slice(1) : value;
    case 'slug':
      return value
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    default:
      return value;
  }
}

/** A parsed placeholder expression. */
export interface ParsedExpr {
  base: string;
  offset: string;
  /** `undefined` when no `:format` was given. */
  format?: string;
  filters: string[];
}

// A base is an identifier that may hold dots (never a leading +/- so date
// offsets stay unambiguous); the optional offset is one or more signed terms.
const BASE_OFFSET_RE = /^([\w.-]*?)((?:[+-]\d+[yMwdhms])*)$/;

/**
 * Parse the inner text of a `{{ … }}` placeholder into its parts. Always
 * succeeds: anything that doesn't parse as offset/format falls back to a bare
 * base, so a malformed placeholder degrades rather than throwing.
 */
export function parseExpr(inner: string): ParsedExpr {
  const segments = inner.split('|');
  const valuePart = segments[0].trim();
  const filters = segments
    .slice(1)
    .map((f) => f.trim())
    .filter(Boolean);

  // The first colon separates base+offset from the (space-bearing) format.
  const colon = valuePart.indexOf(':');
  const baseOffset = (
    colon === -1 ? valuePart : valuePart.slice(0, colon)
  ).trim();
  const format = colon === -1 ? undefined : valuePart.slice(colon + 1).trim();

  const m = BASE_OFFSET_RE.exec(baseOffset);
  const base = (m ? m[1] : baseOffset).trim();
  const offset = m ? m[2] : '';
  return { base, offset, format, filters };
}
