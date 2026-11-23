import { describe, expect, it } from 'vitest';
import {
  browserHostImports,
  clockAdd,
  clockFormat,
  countNotesByDay,
  frontmatter,
  parseRfc3339,
  queryNotes,
  toRfc3339,
  type HostCall
} from './browser-host';

// Cases mirror `src-tauri/plugin-runtime/src/dates.rs`, `markdown.rs` and
// `host.rs`.

const fixed = () => new Date(2026, 6, 25, 14, 5, 9);
const stamp = (date: Date) => clockFormat(date, 'YYYY-MM-DD HH:mm:ss', 'en');

/** The `err` payload a host import throws, or `undefined` if it returns. */
function refusal(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return (error as { payload?: unknown }).payload;
  }
  return undefined;
}

describe('clockFormat', () => {
  it('covers the token set', () => {
    const dt = fixed();
    expect(clockFormat(dt, 'YYYY-MM-DD HH:mm:ss', 'en')).toBe(
      '2026-07-25 14:05:09'
    );
    expect(clockFormat(dt, 'dddd, MMMM D', 'en')).toBe('Saturday, July 25');
    expect(clockFormat(dt, 'hh:mm A', 'en')).toBe('02:05 PM');
    expect(clockFormat(dt, 'h:m:s a', 'en')).toBe('2:5:9 pm');
    expect(clockFormat(dt, 'YY M ddd MMM H', 'en')).toBe('26 7 Sat Jul 14');
    expect(clockFormat(dt, '[Week] YYYY', 'en')).toBe('Week 2026');
    expect(clockFormat(dt, '[open', 'en')).toBe('open');
  });

  it('localizes names for German and falls back to English', () => {
    const dt = fixed();
    expect(clockFormat(dt, 'dddd, D. MMMM', 'de')).toBe('Samstag, 25. Juli');
    expect(clockFormat(dt, 'ddd MMM', 'de-AT')).toBe('Sa Jul');
    expect(clockFormat(dt, 'MMMM', 'fr')).toBe('July');
  });

  it('reads midnight and noon as twelve', () => {
    expect(clockFormat(new Date(2026, 0, 1, 0), 'h A')).toBe('12 AM');
    expect(clockFormat(new Date(2026, 0, 1, 12), 'hh a')).toBe('12 pm');
  });
});

describe('clockAdd', () => {
  it('clamps months to the target month and shifts the other units exactly', () => {
    const jan31 = new Date(2026, 0, 31, 9);
    expect(stamp(clockAdd(jan31, 1, 'month'))).toBe('2026-02-28 09:00:00');
    expect(stamp(clockAdd(new Date(2028, 0, 31, 9), 1, 'month'))).toBe(
      '2028-02-29 09:00:00'
    );
    expect(stamp(clockAdd(jan31, -1, 'year'))).toBe('2025-01-31 09:00:00');
    expect(stamp(clockAdd(jan31, 2, 'week'))).toBe('2026-02-14 09:00:00');
    const dt = fixed();
    expect(stamp(clockAdd(dt, 1, 'hour'))).toBe('2026-07-25 15:05:09');
    expect(stamp(clockAdd(dt, 1, 'minute'))).toBe('2026-07-25 14:06:09');
    expect(stamp(clockAdd(dt, 1, 'second'))).toBe('2026-07-25 14:05:10');
    expect(stamp(clockAdd(dt, 1, 'day'))).toBe('2026-07-26 14:05:09');
  });

  it('keeps the original time when a month shift lands in a DST gap', () => {
    // 02:30 on 2026-03-29 does not exist in most European zones. Elsewhere
    // there is no gap and nothing to check.
    const gap = new Date(2026, 2, 29, 2, 30);
    if (gap.getHours() === 2) return;
    const start = new Date(2026, 0, 29, 2, 30);
    expect(clockAdd(start, 2, 'month')).toEqual(start);
  });

  it('refuses out-of-range shifts', () => {
    for (const unit of [
      'second',
      'minute',
      'hour',
      'day',
      'week',
      'month',
      'year'
    ] as const) {
      for (const amount of [2 ** 63, -(2 ** 63)])
        expect(refusal(() => clockAdd(fixed(), amount, unit))).toEqual({
          tag: 'invalid',
          val: 'date shift is out of range'
        });
    }
  });
});

describe('RFC 3339', () => {
  it('parses what chrono parses', () => {
    const at = Date.UTC(2026, 6, 25, 14, 5, 9);
    expect(parseRfc3339('2026-07-25T14:05:09Z').getTime()).toBe(at);
    expect(parseRfc3339('2026-07-25t16:05:09+02:00').getTime()).toBe(at);
    expect(parseRfc3339('2026-07-25 11:35:09-02:30').getTime()).toBe(at);
    expect(parseRfc3339('2026-07-25T14:05:09.123456789z').getTime()).toBe(
      at + 123
    );
  });

  it('refuses what Date would roll over or guess at', () => {
    for (const input of [
      'yesterday',
      '',
      '2026-02-29T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-07-25T24:00:00Z',
      '2026-07-25T14:05:09',
      '2026-07-25'
    ])
      expect(refusal(() => parseRfc3339(input))).toEqual({
        tag: 'invalid',
        val: 'date input must be an RFC3339 string or epoch seconds'
      });
  });

  it('writes local time with an offset and drops a zero fraction', () => {
    const date = new Date(2026, 6, 25, 14, 5, 9);
    expect(toRfc3339(date)).toMatch(/^2026-07-25T14:05:09[+-]\d{2}:\d{2}$/);
    expect(parseRfc3339(toRfc3339(date))).toEqual(date);
    date.setMilliseconds(7);
    expect(toRfc3339(date)).toMatch(/^2026-07-25T14:05:09\.007[+-]/);
  });
});

describe('frontmatter', () => {
  it('writes scalars and lists in key order', () => {
    expect(
      frontmatter(
        JSON.stringify({
          title: 'Hi "there"\nyou',
          tags: ['a', 1, true, null],
          draft: false,
          count: 3,
          none: null,
          nested: { b: 1, a: [2] }
        })
      )
    ).toBe(
      '---\ncount: 3\ndraft: false\nnested: {"a":[2],"b":1}\nnone: \n' +
        'tags:\n  - "a"\n  - 1\n  - true\n  - \ntitle: "Hi \\"there\\"\\nyou"\n---\n'
    );
  });

  it('refuses anything but an object', () => {
    expect(refusal(() => frontmatter('[1]'))).toEqual({
      tag: 'invalid',
      val: 'frontmatter expects an object'
    });
    expect(refusal(() => frontmatter('"x"'))).toMatchObject({
      tag: 'invalid'
    });
    expect(refusal(() => frontmatter('{'))).toMatchObject({ tag: 'invalid' });
  });
});

describe('queryNotes', () => {
  // Noon UTC is the same calendar day in every time zone the tests run in.
  const dated = (
    id: string,
    folderId: string | undefined,
    created: string,
    modified: string
  ) => ({
    id,
    title: id,
    tags: [],
    kind: 'markdown',
    folderId,
    folderPath: '',
    created: `${created}T12:00:00Z`,
    modified: `${modified}T12:00:00Z`
  });
  const notes = [
    dated('old', undefined, '2026-10-01', '2026-10-02'),
    dated('edited', undefined, '2026-10-01', '2026-11-20'),
    dated('daily', 'journal', '2026-11-19', '2026-11-19'),
    dated('bad', undefined, 'yesterday', '2026-11-19')
  ];
  const ids = (query: Parameters<typeof queryNotes>[1]) =>
    queryNotes(notes, query).map((d) => d.note.id);

  it('filters by folder, local day and title as the Rust host does', () => {
    // Either day inside the range counts, the newest edit first.
    expect(ids({ days: { first: '2026-11-01', last: '2026-11-30' } })).toEqual([
      'edited',
      'daily',
      'bad'
    ]);
    const all = queryNotes(notes, {});
    expect(all[0]).toMatchObject({
      createdDay: '2026-10-01',
      modifiedDay: '2026-11-20'
    });
    expect(all[2].createdDay).toBe('');
    expect(all[3].note.id).toBe('old');
    expect(ids({ limit: 2 })).toEqual(['edited', 'daily']);
    expect(ids({ folder: { tag: 'folder', val: 'journal' } })).toEqual([
      'daily'
    ]);
    expect(
      ids({
        folder: { tag: 'root' },
        days: { first: '2026-10-02', last: '2026-10-02' }
      })
    ).toEqual(['old']);
    expect(ids({ titles: ['daily', 'missing'] })).toEqual(['daily']);
    expect(
      refusal(() =>
        queryNotes(notes, { days: { first: '2026-11-01', last: 'soon' } })
      )
    ).toMatchObject({ tag: 'invalid' });
  });

  it('counts a note once on each day it was created or edited', () => {
    expect(
      countNotesByDay(notes, { first: '2026-11-01', last: '2026-11-30' })
    ).toEqual([
      { day: '2026-11-19', notes: 2 },
      { day: '2026-11-20', notes: 1 }
    ]);
    expect(
      countNotesByDay(notes, { first: '2026-10-01', last: '2026-10-02' })
    ).toEqual([
      { day: '2026-10-01', notes: 2 },
      { day: '2026-10-02', notes: 1 }
    ]);
  });
});

describe('browserHostImports', () => {
  const note = {
    id: 'n1',
    title: 'Daily',
    tags: [],
    kind: 'markdown',
    folderId: undefined,
    folderPath: '',
    created: 'c',
    modified: 'm'
  };
  const imports = (call: Partial<HostCall> = {}) =>
    browserHostImports({
      pluginId: 'p',
      granted: [],
      notes: [],
      nativeTools: [],
      ...call
    }) as unknown as Record<
      string,
      Record<string, (...args: never[]) => unknown>
    >;

  it('needs notes.read for the snapshot', () => {
    const denied = imports({ notes: [note] })['mindstream:plugin/notes'];
    expect(refusal(() => denied.all())).toEqual({
      tag: 'denied',
      val: 'notes.read'
    });
    const notes = imports({ granted: ['notes.read'], notes: [note] })[
      'mindstream:plugin/notes'
    ];
    expect(notes.all()).toEqual([note]);
    expect((notes.get as (id: string) => unknown)('n1')).toEqual(note);
    expect((notes.get as (id: string) => unknown)('n2')).toBeUndefined();
    expect(refusal(() => denied.query({} as never))).toEqual({
      tag: 'denied',
      val: 'notes.read'
    });
    expect(refusal(() => denied.countByDay({} as never))).toEqual({
      tag: 'denied',
      val: 'notes.read'
    });
  });

  it('has no plugin data directory', () => {
    expect(
      refusal(() => imports()['mindstream:plugin/storage'].read())
    ).toEqual({ tag: 'denied', val: 'pluginStorage.read' });
    expect(
      refusal(() =>
        imports({ granted: ['pluginStorage.write'] })[
          'mindstream:plugin/storage'
        ].write()
      )
    ).toEqual({ tag: 'unavailable', val: 'this plugin has no data directory' });
  });

  it('finds no native tool, declared or not', () => {
    const tools = imports({
      granted: ['nativeTools.runDeclared'],
      nativeTools: ['typst']
    })['mindstream:plugin/native-tools'] as Record<
      string,
      (id: string) => unknown
    >;
    expect(tools.available('typst')).toBe(false);
    expect(refusal(() => tools.run('typst'))).toEqual({
      tag: 'unavailable',
      val: "tool 'typst' is not available"
    });
    expect(refusal(() => tools.run('pandoc'))).toEqual({
      tag: 'invalid',
      val: "tool 'pandoc' is not declared in the manifest"
    });
    expect(
      refusal(() =>
        (
          imports()['mindstream:plugin/native-tools'] as Record<
            string,
            (id: string) => unknown
          >
        ).available('typst')
      )
    ).toEqual({ tag: 'denied', val: 'nativeTools.runDeclared' });
  });

  it('caps random bytes per call', () => {
    const runtime = imports()['mindstream:plugin/runtime'] as Record<
      string,
      (len: number) => Uint8Array
    >;
    expect(runtime.randomBytes(65536)).toHaveLength(65536);
    expect(() => runtime.randomBytes(65537)).toThrow(
      'random-bytes: at most 65536 bytes per call'
    );
  });
});
