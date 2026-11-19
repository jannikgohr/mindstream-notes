/**
 * The plugin host interfaces for builds without the Rust backend.
 *
 * The app runs plugin components in Wasmtime against the host in
 * `src-tauri/plugin-runtime`. The browser runs the same component bytes,
 * transpiled by jco (`scripts/browser/plugin-components.mjs`), against these
 * imports. They answer as the Rust host does: `clock` follows `dates.rs`,
 * `markdown` follows `markdown.rs`, and permissions, refusals and their
 * messages follow `host.rs`. A browser has no plugin data directory and no
 * native tools, so storage and tool calls refuse as they do on mobile.
 */

/** `types.note-meta`, as jco lifts and lowers it. */
export interface HostNote {
  id: string;
  title: string;
  tags: string[];
  kind: string;
  folderId: string | undefined;
  folderPath: string;
  created: string;
  modified: string;
}

/** What one call may reach, decided before the plugin starts. */
export interface HostCall {
  pluginId: string;
  granted: readonly string[];
  /** The snapshot behind `notes.*`. Empty unless `notes.read` was granted. */
  notes: HostNote[];
  /** Ids under the manifest's `contributes.nativeTools`. */
  nativeTools: readonly string[];
}

type ErrorTag = 'denied' | 'invalid' | 'unavailable' | 'failed';
type TimeUnit =
  | 'second'
  | 'minute'
  | 'hour'
  | 'day'
  | 'week'
  | 'month'
  | 'year';
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const MAX_RANDOM_BYTES = 64 * 1024;
const INVALID_DATE = 'date input must be an RFC3339 string or epoch seconds';
const OUT_OF_RANGE = 'date shift is out of range';
const NO_DATA_DIRECTORY = 'this plugin has no data directory';

/** A WIT `error` value. jco lowers a thrown object's `payload` into `err`. */
function refuse(tag: ErrorTag, val: string): never {
  throw Object.assign(new Error(val), { payload: { tag, val } });
}

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  if ([1, 3, 5, 7, 8, 10, 12].includes(month)) return 31;
  if ([4, 6, 9, 11].includes(month)) return 30;
  if (month !== 2) return 30;
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
}

/** chrono's `parse_from_rfc3339`, which refuses what `Date` would roll over. */
export function parseRfc3339(input: string): Date {
  const m = RFC3339.exec(input);
  if (!m) refuse('invalid', INVALID_DATE);
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const offsetHours = Number(m[10] ?? 0);
  const offsetMinutes = Number(m[11] ?? 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59
  )
    refuse('invalid', INVALID_DATE);
  const ms = Number((m[7] ?? '').padEnd(3, '0').slice(0, 3));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);
  const offset = (offsetHours * 60 + offsetMinutes) * (m[9] === '-' ? -1 : 1);
  return new Date(date.getTime() - offset * 60_000);
}

const pad2 = (value: number) => String(value).padStart(2, '0');

/** chrono's `to_rfc3339` for a local time: always an offset, never `Z`. */
export function toRfc3339(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const abs = Math.abs(offset);
  const ms = date.getMilliseconds();
  return (
    `${String(date.getFullYear()).padStart(4, '0')}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    (ms === 0 ? '' : `.${String(ms).padStart(3, '0')}`) +
    `${offset < 0 ? '-' : '+'}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

function addMonths(date: Date, months: number): Date {
  const total = date.getFullYear() * 12 + date.getMonth() + months;
  const year = Math.floor(total / 12);
  const month0 = total - year * 12;
  const day = Math.min(date.getDate(), daysInMonth(year, month0 + 1));
  const [hours, minutes, seconds] = [
    date.getHours(),
    date.getMinutes(),
    date.getSeconds()
  ];
  // `setFullYear` rather than the constructor, which maps years 0-99 to 19xx.
  const out = new Date(2000, 0, 1, hours, minutes, seconds);
  out.setFullYear(year, month0, day);
  out.setHours(hours, minutes, seconds, 0);
  if (Number.isNaN(out.getTime())) refuse('invalid', OUT_OF_RANGE);
  // A local time skipped by a DST change has no single answer. The host keeps
  // the original time rather than guessing.
  if (
    out.getFullYear() !== year ||
    out.getMonth() !== month0 ||
    out.getDate() !== day ||
    out.getHours() !== hours ||
    out.getMinutes() !== minutes
  )
    return date;
  return out;
}

const UNIT_MS: Record<Exclude<TimeUnit, 'month' | 'year'>, number> = {
  week: 7 * 86_400_000,
  day: 86_400_000,
  hour: 3_600_000,
  minute: 60_000,
  second: 1_000
};

/** `dates::add`: months and years clamp the day to the target month's length. */
export function clockAdd(date: Date, amount: number, unit: TimeUnit): Date {
  if (unit === 'month' || unit === 'year')
    return addMonths(date, unit === 'year' ? amount * 12 : amount);
  const out = new Date(date.getTime() + amount * UNIT_MS[unit]);
  if (!Number.isFinite(amount) || Number.isNaN(out.getTime()))
    refuse('invalid', OUT_OF_RANGE);
  return out;
}

// English month and weekday names, moment's default locale.
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
];
const MONTHS_SHORT = MONTHS.map((month) => month.slice(0, 3));
const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
];
const WEEKDAYS_SHORT = WEEKDAYS.map((day) => day.slice(0, 3));

// The app ships only `en` and `de`, so a locale that starts with "de" selects
// these and anything else falls back to English.
const MONTHS_DE = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember'
];
const MONTHS_SHORT_DE = [
  'Jan',
  'Feb',
  'Mär',
  'Apr',
  'Mai',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Okt',
  'Nov',
  'Dez'
];
const WEEKDAYS_DE = [
  'Sonntag',
  'Montag',
  'Dienstag',
  'Mittwoch',
  'Donnerstag',
  'Freitag',
  'Samstag'
];
const WEEKDAYS_SHORT_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

// Tried longest first at each position.
const TOKENS = [
  'YYYY',
  'YY',
  'MMMM',
  'MMM',
  'MM',
  'M',
  'DD',
  'D',
  'dddd',
  'ddd',
  'HH',
  'H',
  'hh',
  'h',
  'mm',
  'm',
  'ss',
  's',
  'A',
  'a'
];

/** `dates::format`: moment-style tokens and `[escaped]` literals, local time. */
export function clockFormat(
  date: Date,
  pattern: string,
  locale = 'en'
): string {
  const german = locale.startsWith('de');
  const months = german ? MONTHS_DE : MONTHS;
  const monthsShort = german ? MONTHS_SHORT_DE : MONTHS_SHORT;
  const weekdays = german ? WEEKDAYS_DE : WEEKDAYS;
  const weekdaysShort = german ? WEEKDAYS_SHORT_DE : WEEKDAYS_SHORT;
  const month0 = date.getMonth();
  const h24 = date.getHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const value = (token: string): string => {
    switch (token) {
      case 'YYYY':
        return String(date.getFullYear());
      case 'YY':
        return pad2(((date.getFullYear() % 100) + 100) % 100);
      case 'MMMM':
        return months[month0];
      case 'MMM':
        return monthsShort[month0];
      case 'MM':
        return pad2(month0 + 1);
      case 'M':
        return String(month0 + 1);
      case 'DD':
        return pad2(date.getDate());
      case 'D':
        return String(date.getDate());
      case 'dddd':
        return weekdays[date.getDay()];
      case 'ddd':
        return weekdaysShort[date.getDay()];
      case 'HH':
        return pad2(h24);
      case 'H':
        return String(h24);
      case 'hh':
        return pad2(h12);
      case 'h':
        return String(h12);
      case 'mm':
        return pad2(date.getMinutes());
      case 'm':
        return String(date.getMinutes());
      case 'ss':
        return pad2(date.getSeconds());
      case 's':
        return String(date.getSeconds());
      case 'A':
        return h24 < 12 ? 'AM' : 'PM';
      default:
        return h24 < 12 ? 'am' : 'pm';
    }
  };
  const chars = Array.from(pattern);
  let out = '';
  let i = 0;
  outer: while (i < chars.length) {
    // `[literal]` is copied up to the next `]`.
    if (chars[i] === '[') {
      let j = i + 1;
      while (j < chars.length && chars[j] !== ']') out += chars[j++];
      i = j < chars.length ? j + 1 : j;
      continue;
    }
    for (const token of TOKENS) {
      if (chars.slice(i, i + token.length).join('') === token) {
        out += value(token);
        i += token.length;
        continue outer;
      }
    }
    out += chars[i++];
  }
  return out;
}

/** Rust's `str` order: by code point (UTF-8 bytes), where JS `<` uses UTF-16 units. */
function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const diff = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/** serde_json's compact output, whose objects are key-sorted maps. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareCodePoints)
      .map((key) => `${JSON.stringify(key)}:${sortedJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function yamlScalar(value: unknown): string {
  if (typeof value === 'string')
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  if (value === null) return '';
  if (typeof value === 'boolean' || typeof value === 'number')
    return String(value);
  return sortedJson(value);
}

/** `markdown::frontmatter`. */
export function frontmatter(fieldsJson: string): string {
  let fields: unknown;
  try {
    fields = JSON.parse(fieldsJson);
  } catch (error) {
    refuse(
      'invalid',
      `frontmatter: invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields))
    refuse('invalid', 'frontmatter expects an object');
  const record = fields as Record<string, unknown>;
  let out = '---\n';
  for (const key of Object.keys(record).sort(compareCodePoints)) {
    const value = record[key];
    if (Array.isArray(value)) {
      out += `${key}:\n`;
      for (const item of value) out += `  - ${yamlScalar(item)}\n`;
    } else {
      out += `${key}: ${yamlScalar(value)}\n`;
    }
  }
  return `${out}---\n`;
}

/** `runtime.uuid`. `randomUUID` needs a secure context, which plain HTTP lacks. */
export function newUuid(): string {
  // Typed as always present, but missing outside secure contexts.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    ''
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The import object for one call, keyed the way jco's bindings look it up. */
export function browserHostImports(
  call: HostCall
): Record<string, Record<string, unknown>> {
  const granted = new Set(call.granted);
  const need = (permission: string) => {
    if (!granted.has(permission)) refuse('denied', permission);
  };
  const noStorage = (permission: string): never => {
    need(permission);
    refuse('unavailable', NO_DATA_DIRECTORY);
  };
  return {
    'mindstream:plugin/types': {},
    'mindstream:plugin/runtime': {
      log(level: LogLevel, message: string) {
        console[level](`[plugin ${call.pluginId}] ${message}`);
      },
      uuid: newUuid,
      randomBytes(len: number) {
        if (len > MAX_RANDOM_BYTES)
          throw new Error(
            `random-bytes: at most ${MAX_RANDOM_BYTES} bytes per call`
          );
        return crypto.getRandomValues(new Uint8Array(len));
      },
      hasPermission: (permission: string) => granted.has(permission)
    },
    'mindstream:plugin/clock': {
      nowMillis: () => BigInt(Date.now()),
      now: () => toRfc3339(new Date()),
      format: (timestamp: string, pattern: string, locale?: string) =>
        clockFormat(parseRfc3339(timestamp), pattern, locale ?? 'en'),
      add: (timestamp: string, amount: bigint, unit: TimeUnit) =>
        toRfc3339(clockAdd(parseRfc3339(timestamp), Number(amount), unit))
    },
    'mindstream:plugin/markdown': { frontmatter },
    'mindstream:plugin/notes': {
      all() {
        need('notes.read');
        return call.notes;
      },
      get(id: string) {
        need('notes.read');
        return call.notes.find((note) => note.id === id);
      }
    },
    'mindstream:plugin/storage': {
      read: () => noStorage('pluginStorage.read'),
      list: () => noStorage('pluginStorage.read'),
      write: () => noStorage('pluginStorage.write'),
      delete: () => noStorage('pluginStorage.write')
    },
    'mindstream:plugin/native-tools': {
      available() {
        need('nativeTools.runDeclared');
        return false;
      },
      run(toolId: string) {
        need('nativeTools.runDeclared');
        if (call.nativeTools.includes(toolId))
          refuse('unavailable', `tool '${toolId}' is not available`);
        refuse('invalid', `tool '${toolId}' is not declared in the manifest`);
      }
    }
  };
}
