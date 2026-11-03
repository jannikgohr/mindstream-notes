/**
 * The bundled Templates plugin, for builds without the WebAssembly host.
 *
 * The app runs `plugins/templates/plugin.wasm` through Wasmtime in the Rust
 * backend, and a browser has neither. This module ports that component's two
 * exports (`plugin-sdk/bundled/templates/src/lib.rs`) and the host clock it
 * imports (`src-tauri/plugin-runtime/src/dates.rs`) line for line, so a
 * template renders the same text in the browser as in the app. It deliberately
 * does not reuse `template-format.ts`: that engine resolves variables before
 * dates, trims Unicode whitespace, applies Unicode case filters and lets month
 * math overflow, and each of those would change a rendered note.
 *
 * Keep the two in step: a change to the Rust plugin or the host clock needs the
 * same change here, and the cases in `browser-templates.test.ts` mirror the
 * Rust tests.
 */

/** What the plugin reads from its host's `notes.all()`. */
export interface TemplateHostNote {
  id: string;
  title: string;
  tags: string[];
  folderId: string | null;
}

/** Host imports the component calls besides the clock. */
export interface TemplateHost {
  notes: () => TemplateHostNote[];
  uuid: () => string;
}

type TimeUnit = 'y' | 'M' | 'w' | 'd' | 'h' | 'm' | 's';

const INVALID_DATE = 'date input must be an RFC3339 string or epoch seconds';
const OUT_OF_RANGE = 'date shift is out of range';
const I64_MAX = 2n ** 63n - 1n;

function parseDate(input: string): Date {
  const date = new Date(input);
  if (input === '' || Number.isNaN(date.getTime()))
    throw new Error(INVALID_DATE);
  return date;
}

function daysInMonth(year: number, month: number): number {
  if ([1, 3, 5, 7, 8, 10, 12].includes(month)) return 31;
  if ([4, 6, 9, 11].includes(month)) return 30;
  if (month !== 2) return 30;
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
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
  if (Number.isNaN(out.getTime())) throw new Error(OUT_OF_RANGE);
  // A local time skipped by a DST change has no single answer. The host keeps
  // the original time rather than guessing, and so does this port.
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

const UNIT_MS: Record<'w' | 'd' | 'h' | 'm' | 's', number> = {
  w: 7 * 86_400_000,
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1_000
};

/** `clock.add`: months and years clamp the day to the target month's length. */
export function clockAdd(date: Date, amount: number, unit: TimeUnit): Date {
  if (unit === 'M' || unit === 'y')
    return addMonths(date, unit === 'y' ? amount * 12 : amount);
  const out = new Date(date.getTime() + amount * UNIT_MS[unit]);
  if (!Number.isFinite(amount) || Number.isNaN(out.getTime()))
    throw new Error(OUT_OF_RANGE);
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

const pad2 = (value: number) => String(value).padStart(2, '0');

/** `clock.format`: moment-style tokens and `[escaped]` literals, local time. */
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

// Rust's `trim_matches` set: ASCII whitespace only, unlike `String#trim`.
const trim = (value: string) =>
  value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '');

/** JSON values stringified the way the plugin's `js_string` does. */
function jsString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(jsString).join(',');
  if (typeof value === 'object') return '[object Object]';
  return String(value);
}

const isAsciiAlphanumeric = (c: string) => /^[A-Za-z0-9]$/.test(c);
const asciiUpper = (value: string) =>
  value.replace(/[a-z]/g, (c) => c.toUpperCase());
const asciiLower = (value: string) =>
  value.replace(/[A-Z]/g, (c) => c.toLowerCase());

function filter(value: string, name: string): string {
  switch (name) {
    case 'upper':
      return asciiUpper(value);
    case 'lower':
      return asciiLower(value);
    case 'trim':
      return trim(value);
    case 'capitalize':
      return asciiUpper(value.slice(0, 1)) + value.slice(1);
    case 'slug': {
      let out = '';
      let separator = false;
      for (const c of value) {
        if (isAsciiAlphanumeric(c)) {
          if (separator && out !== '') out += '-';
          out += c.toLowerCase();
          separator = false;
        } else {
          separator = true;
        }
      }
      return out;
    }
    default:
      return value;
  }
}

interface Expression {
  base: string;
  format: string | null;
  offsets: [string, TimeUnit][];
}

function expression(inner: string): Expression {
  const value = trim(inner.split('|')[0] ?? '');
  const colon = value.indexOf(':');
  let base = colon === -1 ? value : trim(value.slice(0, colon));
  const format = colon === -1 ? null : trim(value.slice(colon + 1));
  const offsets: [string, TimeUnit][] = [];
  for (;;) {
    const unit = base.at(-1);
    if (!unit || !'yMwdhms'.includes(unit)) break;
    let start = base.length - 1;
    while (start > 0 && /[0-9]/.test(base[start - 1])) start--;
    if (
      start === base.length - 1 ||
      start === 0 ||
      !'+-'.includes(base[start - 1])
    )
      break;
    offsets.push([base.slice(start - 1, base.length - 1), unit as TimeUnit]);
    base = base.slice(0, start - 1);
  }
  return { base: trim(base), format, offsets };
}

const DEFAULT_FORMATS: Record<string, string> = {
  date: 'YYYY-MM-DD',
  time: 'HH:mm',
  datetime: 'YYYY-MM-DD HH:mm',
  now: 'YYYY-MM-DD HH:mm'
};

type Vars = Record<string, unknown>;

function resolve(
  inner: string,
  input: Record<string, unknown>,
  vars: Vars,
  host: TemplateHost
): string {
  const filters = inner.split('|').slice(1);
  const { base, format, offsets } = expression(inner);
  const defaultFormat = Object.hasOwn(DEFAULT_FORMATS, base)
    ? DEFAULT_FORMATS[base]
    : null;
  let value: string;
  if (base === 'uuid') {
    value = host.uuid();
  } else if (defaultFormat) {
    let time = parseDate(typeof input.now === 'string' ? input.now : '');
    for (const [count, unit] of offsets.reverse()) {
      const amount = BigInt(count);
      if (amount > I64_MAX || amount < -I64_MAX - 1n)
        throw new Error('invalid clock offset');
      time = clockAdd(time, Number(amount), unit);
    }
    value = clockFormat(
      time,
      format ?? defaultFormat,
      typeof input.locale === 'string' ? input.locale : 'en'
    );
  } else {
    value = jsString(Object.hasOwn(vars, base) ? vars[base] : null);
  }
  for (const name of filters) value = filter(value, trim(name));
  return value;
}

function render(
  text: string,
  input: Record<string, unknown>,
  vars: Vars,
  host: TemplateHost
): string {
  let remaining = text;
  let out = '';
  for (;;) {
    const open = remaining.indexOf('{{');
    if (open === -1) break;
    const close = remaining.indexOf('}}', open + 2);
    if (close === -1) break;
    out += remaining.slice(0, open);
    out += resolve(remaining.slice(open + 2, close), input, vars, host);
    remaining = remaining.slice(close + 2);
  }
  return out + remaining;
}

function under(
  folderId: string | null,
  target: string,
  parents: Map<string, string | null>
): boolean {
  const seen = new Set<string>();
  let current = folderId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    if (current === target) return true;
    current = parents.get(current) ?? null;
  }
  return false;
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

const nonEmptyString = (value: unknown) =>
  typeof value === 'string' && value !== '' ? value : null;

function menu(input: Record<string, unknown>, host: TemplateHost): unknown {
  const settings = (input.settings ?? {}) as Record<string, unknown>;
  const folder = nonEmptyString(settings['source-folder']);
  const tag = nonEmptyString(settings['source-tag']);
  if (!folder && !tag) {
    return {
      effect: 'toast',
      message: 'Set a template folder or tag in Settings → Plugins → Templates.'
    };
  }
  const parents = new Map<string, string | null>();
  for (const f of Array.isArray(input.folders) ? input.folders : []) {
    const { id, parentId } = (f ?? {}) as Record<string, unknown>;
    if (typeof id === 'string')
      parents.set(id, typeof parentId === 'string' ? parentId : null);
  }
  const items = host
    .notes()
    .filter(
      (n) =>
        (tag !== null && n.tags.includes(tag)) ||
        (folder !== null && under(n.folderId, folder, parents))
    )
    .map((n) => ({
      label: n.title,
      run: { effect: 'createNoteFromNote', sourceNoteId: n.id }
    }))
    .sort((a, b) => compareCodePoints(a.label, b.label));
  return items.length === 0
    ? { effect: 'toast', message: 'No template notes found.' }
    : { effect: 'openMenu', items };
}

/** The component's `invoke(export, input)`. Throws where the plugin errors. */
export function invokeTemplatesPlugin(
  exportName: string,
  rawInput: unknown,
  host: TemplateHost
): unknown {
  const input =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {};
  switch (exportName) {
    case '$exports':
      return ['newFromTemplate', 'renderTemplate'];
    case 'newFromTemplate':
      return menu(input, host);
    case 'renderTemplate': {
      const vars: Vars =
        input.vars &&
        typeof input.vars === 'object' &&
        !Array.isArray(input.vars)
          ? { ...(input.vars as Vars) }
          : {};
      const title = render(
        typeof input.title === 'string' ? input.title : '',
        input,
        vars,
        host
      );
      vars.title = title;
      const body = render(
        typeof input.body === 'string' ? input.body : '',
        input,
        vars,
        host
      );
      return { title, body };
    }
    default:
      throw new Error(`unknown export ${exportName}`);
  }
}
