import { createBatchHost } from './mock-batch.js';
// The host interfaces, implemented in JavaScript for testing a plugin in Node.
//
// This mirrors what the app's Rust host does (src-tauri/plugin-runtime): the
// same permission checks, the same storage path rules and size limit, the
// same date tokens and frontmatter output. It does not enforce time or memory
// limits; run the plugin in the app or the conformance runner for those.

import { randomBytes as nodeRandomBytes, randomUUID } from 'node:crypto';

export const MAX_STORAGE_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_RANDOM_BYTES = 65536;

/** A WIT `err` value, thrown the way transpiled components expect. */
function refuse(tag, val) {
  // A plain object with `payload`: the bindings turn it into the `err` case.
  throw { payload: { tag, val } };
}

const MONTHS = {
  en: [
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
  ],
  de: [
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
  ]
};
const MONTHS_SHORT = {
  en: [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ],
  de: [
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
  ]
};
const WEEKDAYS = {
  en: [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday'
  ],
  de: [
    'Sonntag',
    'Montag',
    'Dienstag',
    'Mittwoch',
    'Donnerstag',
    'Freitag',
    'Samstag'
  ]
};
const WEEKDAYS_SHORT = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  de: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']
};
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

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** Calendar fields of `date` in the zone the host is pretending to be in. */
function fields(date, utc) {
  return utc
    ? {
        y: date.getUTCFullYear(),
        mo: date.getUTCMonth(),
        d: date.getUTCDate(),
        wd: date.getUTCDay(),
        h: date.getUTCHours(),
        mi: date.getUTCMinutes(),
        s: date.getUTCSeconds()
      }
    : {
        y: date.getFullYear(),
        mo: date.getMonth(),
        d: date.getDate(),
        wd: date.getDay(),
        h: date.getHours(),
        mi: date.getMinutes(),
        s: date.getSeconds()
      };
}

/** The host's moment-style formatter (`dates::format` in the runtime). */
export function formatDate(date, pattern, locale, utc) {
  const lang = (locale ?? 'en').startsWith('de') ? 'de' : 'en';
  const f = fields(date, utc);
  const h12 = f.h % 12 === 0 ? 12 : f.h % 12;
  const values = {
    YYYY: String(f.y),
    YY: pad(((f.y % 100) + 100) % 100),
    MMMM: MONTHS[lang][f.mo],
    MMM: MONTHS_SHORT[lang][f.mo],
    MM: pad(f.mo + 1),
    M: String(f.mo + 1),
    DD: pad(f.d),
    D: String(f.d),
    dddd: WEEKDAYS[lang][f.wd],
    ddd: WEEKDAYS_SHORT[lang][f.wd],
    HH: pad(f.h),
    H: String(f.h),
    hh: pad(h12),
    h: String(h12),
    mm: pad(f.mi),
    m: String(f.mi),
    ss: pad(f.s),
    s: String(f.s),
    A: f.h < 12 ? 'AM' : 'PM',
    a: f.h < 12 ? 'am' : 'pm'
  };
  const chars = [...pattern];
  let out = '';
  let i = 0;
  outer: while (i < chars.length) {
    if (chars[i] === '[') {
      let j = i + 1;
      while (j < chars.length && chars[j] !== ']') out += chars[j++];
      i = j < chars.length ? j + 1 : j;
      continue;
    }
    for (const token of TOKENS) {
      if (chars.slice(i, i + token.length).join('') === token) {
        out += values[token];
        i += token.length;
        continue outer;
      }
    }
    out += chars[i++];
  }
  return out;
}

/** RFC 3339 with the offset of the zone the host is pretending to be in. */
export function rfc3339(date, utc) {
  const offset = utc ? 0 : -date.getTimezoneOffset();
  const local = new Date(date.getTime() + offset * 60000);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const iso = local.toISOString().replace(/\.\d{3}Z$/, '');
  return `${iso}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function parseTimestamp(timestamp) {
  const ok =
    /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(
      timestamp
    );
  const date = ok ? new Date(timestamp) : null;
  if (!date || Number.isNaN(date.getTime())) {
    refuse('invalid', 'date input must be an RFC3339 string or epoch seconds');
  }
  return date;
}

const UNIT_MS = {
  second: 1000,
  minute: 60000,
  hour: 3600000,
  day: 86400000,
  week: 604800000
};

/** The host's calendar arithmetic (`dates::add`). */
export function addToDate(date, amount, unit, utc) {
  if (unit in UNIT_MS) {
    // Exact durations, as the host adds them: across a DST change a day is
    // still 24 hours, so the wall-clock time moves.
    return new Date(date.getTime() + amount * UNIT_MS[unit]);
  }
  const months = unit === 'year' ? amount * 12 : amount;
  const f = fields(date, utc);
  const total = f.y * 12 + f.mo + months;
  const year = Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(f.d, lastDay);
  return utc
    ? new Date(Date.UTC(year, month, day, f.h, f.mi, f.s))
    : new Date(year, month, day, f.h, f.mi, f.s);
}

function yamlScalar(value) {
  if (typeof value === 'string') {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  if (value === null) return '';
  if (typeof value === 'boolean' || typeof value === 'number')
    return String(value);
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])])
    );
  }
  return value;
}

/** The host's frontmatter writer (`markdown::frontmatter`). */
export function frontmatter(fieldsJson) {
  let parsed;
  try {
    parsed = JSON.parse(fieldsJson);
  } catch (error) {
    refuse('invalid', `frontmatter: invalid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    refuse('invalid', 'frontmatter expects an object');
  }
  let out = '---\n';
  for (const key of Object.keys(parsed).sort()) {
    const value = parsed[key];
    if (Array.isArray(value)) {
      out += `${key}:\n`;
      for (const item of value) out += `  - ${yamlScalar(item)}\n`;
    } else {
      out += `${key}: ${yamlScalar(value)}\n`;
    }
  }
  return out + '---\n';
}

/** The host's storage path rules (`paths::split_rel_path`). */
export function storageSegments(path, allowEmpty) {
  if (path.startsWith('/') || path.includes('\\')) {
    refuse('invalid', `unsafe plugin storage path '${path}'`);
  }
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') {
    if (allowEmpty) return [];
    refuse('invalid', 'plugin storage path is empty');
  }
  const segments = trimmed.split('/').filter((s) => s !== '');
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      refuse('invalid', `unsafe plugin storage path '${path}'`);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
      refuse('invalid', `unsafe plugin storage path segment '${segment}'`);
    }
  }
  return segments;
}

/**
 * Build the import object for a transpiled plugin component.
 *
 * @param {import('./testing.js').HostOptions} options
 */
export function createMockHost(options = {}) {
  const granted = new Set(options.permissions ?? []);
  const utc = options.timeZone === 'UTC';
  const fixedNow =
    options.now === undefined ? undefined : new Date(options.now).getTime();
  const nowMs = () => fixedNow ?? Date.now();
  const files = options.storage ?? new Map();
  const notes = options.notes ?? [];
  const tools = options.tools ?? {};
  const logs = [];

  const need = (permission) => {
    if (!granted.has(permission)) refuse('denied', permission);
  };
  const storageNeed = (permission) => {
    need(permission);
    if (options.dataDirectory === false) {
      refuse('unavailable', 'this plugin has no data directory');
    }
  };
  const key = (path, allowEmpty = false) =>
    storageSegments(path, allowEmpty).join('/');
  const toNote = (n) => ({
    id: n.id,
    title: n.title,
    tags: n.tags ?? [],
    kind: n.kind ?? 'markdown',
    folderId: n.folderId ?? undefined,
    folderPath: n.folderPath ?? '',
    created: n.created ?? '2026-01-01T00:00:00Z',
    modified: n.modified ?? n.created ?? '2026-01-01T00:00:00Z'
  });

  const imports = {
    'mindstream:plugin/types@0.1.0': {},
    'mindstream:plugin/runtime@0.1.0': {
      log(level, message) {
        logs.push({ level, message });
      },
      uuid: () => randomUUID(),
      randomBytes(len) {
        if (len > MAX_RANDOM_BYTES) {
          throw new Error(
            `random-bytes: at most ${MAX_RANDOM_BYTES} bytes per call`
          );
        }
        return new Uint8Array(nodeRandomBytes(len));
      },
      hasPermission: (permission) => granted.has(permission)
    },
    'mindstream:plugin/clock@0.1.0': {
      nowMillis: () => BigInt(nowMs()),
      now: () => rfc3339(new Date(nowMs()), utc),
      format: (timestamp, pattern, locale) =>
        formatDate(parseTimestamp(timestamp), pattern, locale ?? 'en', utc),
      add: (timestamp, amount, unit) =>
        rfc3339(
          addToDate(parseTimestamp(timestamp), Number(amount), unit, utc),
          utc
        )
    },
    'mindstream:plugin/markdown@0.1.0': { frontmatter },
    'mindstream:plugin/notes@0.1.0': {
      all() {
        need('notes.read');
        return notes.map(toNote);
      },
      get(id) {
        need('notes.read');
        const note = notes.find((n) => n.id === id);
        return note ? toNote(note) : undefined;
      }
    },
    'mindstream:plugin/storage@0.1.0': {
      read(path) {
        storageNeed('pluginStorage.read');
        const contents = files.get(key(path));
        if (
          contents !== undefined &&
          Buffer.byteLength(contents) > MAX_STORAGE_FILE_BYTES
        ) {
          refuse(
            'invalid',
            `storage.read: '${path}' is larger than ${MAX_STORAGE_FILE_BYTES} bytes`
          );
        }
        return contents;
      },
      list(path) {
        storageNeed('pluginStorage.read');
        const dir = key(path, true);
        const prefix = dir === '' ? '' : `${dir}/`;
        const entries = new Map();
        for (const [name, contents] of files) {
          if (!name.startsWith(prefix)) continue;
          const rest = name.slice(prefix.length).split('/');
          if (rest.length === 1) {
            entries.set(rest[0], {
              name: rest[0],
              isDir: false,
              sizeBytes: BigInt(Buffer.byteLength(contents))
            });
          } else if (!entries.has(rest[0])) {
            entries.set(rest[0], { name: rest[0], isDir: true, sizeBytes: 0n });
          }
        }
        return [...entries.values()].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0
        );
      },
      write(path, contents) {
        storageNeed('pluginStorage.write');
        if (Buffer.byteLength(contents) > MAX_STORAGE_FILE_BYTES) {
          refuse(
            'invalid',
            `storage.write: '${path}' exceeds ${MAX_STORAGE_FILE_BYTES} bytes`
          );
        }
        files.set(key(path), contents);
      },
      delete(path) {
        storageNeed('pluginStorage.write');
        const target = key(path);
        for (const name of [...files.keys()]) {
          if (name === target || name.startsWith(`${target}/`))
            files.delete(name);
        }
      }
    },
    'mindstream:plugin/native-tools@0.1.0': {
      available(toolId) {
        need('nativeTools.runDeclared');
        return typeof tools[toolId] === 'function';
      },
      run(toolId, runOptions) {
        need('nativeTools.runDeclared');
        if (!(toolId in tools)) {
          refuse('invalid', `tool '${toolId}' is not declared in the manifest`);
        }
        const tool = tools[toolId];
        if (typeof tool !== 'function') {
          refuse('unavailable', `tool '${toolId}' is not available`);
        }
        const result = tool({
          args: runOptions.args,
          stdin: runOptions.stdin ?? undefined,
          timeoutMs: runOptions.timeoutMs ?? undefined
        });
        const stdout =
          typeof result.stdout === 'string'
            ? Buffer.from(result.stdout)
            : Buffer.from(result.stdout ?? []);
        return {
          statusCode: result.statusCode ?? 0,
          stdout: runOptions.outputBase64 ? '' : stdout.toString('utf8'),
          stdoutBase64: runOptions.outputBase64
            ? stdout.toString('base64')
            : undefined,
          stderr: result.stderr ?? '',
          timedOut: result.timedOut ?? false
        };
      }
    }
  };

  imports['mindstream:plugin/batch@0.1.0'] = createBatchHost(imports);

  // Transpiled bindings look interfaces up without their version; the
  // versioned names are kept too, for readers of a WIT world.
  for (const name of Object.keys(imports)) {
    imports[name.replace(/@[^@]+$/, '')] = imports[name];
  }
  return { imports, logs, storage: files };
}
