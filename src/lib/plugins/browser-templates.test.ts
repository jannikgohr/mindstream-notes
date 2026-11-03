import { describe, expect, it } from 'vitest';
import {
  clockAdd,
  clockFormat,
  invokeTemplatesPlugin,
  type TemplateHost,
  type TemplateHostNote
} from './browser-templates';

// Cases mirror `src-tauri/plugin-runtime/src/dates.rs` and
// `plugin-sdk/bundled/templates/src/lib.rs`.

const fixed = () => new Date(2026, 6, 25, 14, 5, 9);
const stamp = (date: Date) => clockFormat(date, 'YYYY-MM-DD HH:mm:ss', 'en');

function host(notes: TemplateHostNote[] = []): TemplateHost {
  return { notes: () => notes, uuid: () => 'uuid-1' };
}

function render(input: Record<string, unknown>) {
  return invokeTemplatesPlugin('renderTemplate', input, host()) as {
    title: string;
    body: string;
  };
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
    expect(stamp(clockAdd(jan31, 1, 'M'))).toBe('2026-02-28 09:00:00');
    expect(stamp(clockAdd(new Date(2028, 0, 31, 9), 1, 'M'))).toBe(
      '2028-02-29 09:00:00'
    );
    expect(stamp(clockAdd(jan31, -1, 'y'))).toBe('2025-01-31 09:00:00');
    expect(stamp(clockAdd(jan31, 2, 'w'))).toBe('2026-02-14 09:00:00');
    const dt = fixed();
    expect(stamp(clockAdd(dt, 1, 'h'))).toBe('2026-07-25 15:05:09');
    expect(stamp(clockAdd(dt, 1, 'm'))).toBe('2026-07-25 14:06:09');
    expect(stamp(clockAdd(dt, 1, 's'))).toBe('2026-07-25 14:05:10');
    expect(stamp(clockAdd(dt, 1, 'd'))).toBe('2026-07-26 14:05:09');
  });

  it('keeps the original time when a month shift lands in a DST gap', () => {
    // 02:30 on 2026-03-29 does not exist in most European zones. Elsewhere
    // there is no gap and nothing to check.
    const gap = new Date(2026, 2, 29, 2, 30);
    if (gap.getHours() === 2) return;
    const start = new Date(2026, 0, 29, 2, 30);
    expect(clockAdd(start, 2, 'M')).toEqual(start);
  });

  it('refuses out-of-range shifts', () => {
    for (const unit of ['s', 'm', 'h', 'd', 'w', 'M', 'y'] as const) {
      expect(() => clockAdd(fixed(), Number.MAX_SAFE_INTEGER, unit)).toThrow(
        'date shift is out of range'
      );
    }
  });
});

describe('renderTemplate', () => {
  it('keeps ASCII-only filters and JSON value conversion', () => {
    const out = render({
      title: '{{word|trim|capitalize}}',
      body: '{{title|upper}}/{{word|slug}}/{{emoji|capitalize}}/{{arr}}/{{obj}}/{{float}}/{{missing}}/{{word|unknown}}',
      vars: {
        word: ' hÄllo WORLD ',
        emoji: '😀café',
        arr: [1, null, true, ['a', 'b']],
        obj: {},
        float: 1.0
      }
    });
    expect(out.title).toBe('HÄllo WORLD');
    expect(out.body).toBe(
      'HÄLLO WORLD/h-llo-world/😀café/1,,true,a,b/[object Object]/1// hÄllo WORLD '
    );
  });

  it('ignores offsets on variables and leaves unclosed text literal', () => {
    expect(
      render({
        body: '{{name+999999999999999999999999999999999999999d}} {{literal',
        vars: { name: 'Ada' }
      }).body
    ).toBe('Ada {{literal');
  });

  it('renders dates in local time with chained offsets, and the built-ins win over variables', () => {
    const now = new Date(2026, 0, 31, 12).toISOString();
    const out = render({
      now,
      locale: 'de',
      title: 'Log {{date:YYYY}}',
      body: '{{title}} {{date+1M}} {{date-1y+2w:dddd}} {{date}} {{uuid}}',
      vars: { date: 'overridden' }
    });
    expect(out.title).toBe('Log 2026');
    expect(out.body).toBe('Log 2026 2026-02-28 Freitag 2026-01-31 uuid-1');
  });

  it('fails on a date placeholder without a usable clock', () => {
    expect(() => render({ body: '{{date}}' })).toThrow(/RFC3339/);
    expect(() =>
      render({
        now: new Date().toISOString(),
        body: '{{date+99999999999999999999d}}'
      })
    ).toThrow('invalid clock offset');
  });
});

describe('newFromTemplate', () => {
  const notes: TemplateHostNote[] = [
    { id: 'z', title: 'Zulu', tags: [], folderId: 'child' },
    { id: 'a', title: 'Alpha', tags: ['template'], folderId: null },
    { id: 'c', title: 'Cycle', tags: [], folderId: 'cycle' },
    { id: 'o', title: 'Other', tags: [], folderId: null }
  ];
  const folders = [
    { id: 'root', parentId: null },
    { id: 'child', parentId: 'root' },
    { id: 'cycle', parentId: 'cycle' }
  ];

  it('asks for a source before one is set', () => {
    expect(invokeTemplatesPlugin('newFromTemplate', {}, host(notes))).toEqual({
      effect: 'toast',
      message: 'Set a template folder or tag in Settings → Plugins → Templates.'
    });
  });

  it('lists notes from the folder tree and the tag, sorted by title', () => {
    expect(
      invokeTemplatesPlugin(
        'newFromTemplate',
        {
          settings: { 'source-folder': 'root', 'source-tag': 'template' },
          folders
        },
        host(notes)
      )
    ).toEqual({
      effect: 'openMenu',
      items: [
        {
          label: 'Alpha',
          run: { effect: 'createNoteFromNote', sourceNoteId: 'a' }
        },
        {
          label: 'Zulu',
          run: { effect: 'createNoteFromNote', sourceNoteId: 'z' }
        }
      ]
    });
  });

  it('says so when the source is empty', () => {
    expect(
      invokeTemplatesPlugin(
        'newFromTemplate',
        { settings: { 'source-tag': 'missing' }, folders },
        host(notes)
      )
    ).toEqual({ effect: 'toast', message: 'No template notes found.' });
  });
});

it('reports its exports and rejects unknown ones', () => {
  expect(invokeTemplatesPlugin('$exports', {}, host())).toEqual([
    'newFromTemplate',
    'renderTemplate'
  ]);
  expect(() => invokeTemplatesPlugin('nope', {}, host())).toThrow(
    'unknown export nope'
  );
});
