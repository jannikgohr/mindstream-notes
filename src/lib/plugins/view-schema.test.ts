import { describe, expect, it, vi } from 'vitest';

vi.mock('./effects', () => ({
  parsePluginEffect: (value: { effect?: string; noteId?: unknown }) =>
    value.effect === 'openNote' && typeof value.noteId === 'string'
      ? { effect: 'openNote', noteId: value.noteId }
      : null
}));

const locale = vi.hoisted(() => ({ language: 'en' }));
vi.mock('$lib/settings/i18n.svelte', () => ({ i18n: locale }));
vi.mock('./plugin-i18n', () => {
  const strings: Record<string, Record<string, string>> = {
    en: {
      'notes.one': '{count} note',
      'notes.other': '{count} notes',
      hello: 'Hello, {name}'
    },
    de: { 'notes.one': '{count} Notiz', 'notes.other': '{count} Notizen' }
  };
  const find = (key: string) =>
    strings[locale.language]?.[key] ?? strings.en[key];
  return {
    resolvePluginString: (id: string, key: string) =>
      find(key) ?? `plugins.${id}.${key}`,
    resolvePluginStringOptional: (_id: string, key: string) => find(key)
  };
});

import { parseViewNode, viewText } from './view-schema';

describe('parseViewNode', () => {
  it('keeps the known nodes and drops unknown ones and bad fields', () => {
    expect(
      parseViewNode({
        type: 'stack',
        children: [
          { type: 'heading', text: 'Monday' },
          { type: 'script', src: 'x' },
          {
            type: 'calendar',
            month: '2026-11',
            selected: '2026-11-31x',
            days: {
              '2026-11-19': { marks: ['accent', 'red', 'muted'], strong: true },
              'not-a-day': { marks: ['accent'] }
            },
            onSelect: 'select',
            onMonth: 'month'
          },
          {
            type: 'list',
            items: [
              {
                label: 'Daily',
                icon: '../../etc/passwd.svg',
                tone: 'loud',
                on: { effect: 'openNote', noteId: 'n1' }
              },
              { label: 'Create', on: { event: 'open', value: '2026-11-19' } },
              { label: 'Bad event', on: { event: 'has space' } },
              { notALabel: true }
            ]
          }
        ]
      })
    ).toEqual({
      type: 'stack',
      children: [
        { type: 'heading', text: 'Monday' },
        {
          type: 'calendar',
          month: '2026-11',
          selected: undefined,
          days: {
            '2026-11-19': {
              marks: ['accent', 'muted'],
              strong: true,
              title: undefined
            }
          },
          onSelect: 'select',
          onMonth: 'month'
        },
        {
          type: 'list',
          items: [
            {
              label: 'Daily',
              detail: undefined,
              icon: undefined,
              noteKind: undefined,
              tone: 'default',
              on: { effect: 'openNote', noteId: 'n1' }
            },
            {
              label: 'Create',
              detail: undefined,
              icon: undefined,
              noteKind: undefined,
              tone: 'default',
              on: { event: 'open', value: '2026-11-19' }
            },
            {
              label: 'Bad event',
              detail: undefined,
              icon: undefined,
              noteKind: undefined,
              tone: 'default',
              on: undefined
            }
          ]
        }
      ]
    });
  });

  it('refuses a calendar without a month or events, and trees nested too deep', () => {
    expect(
      parseViewNode({
        type: 'calendar',
        month: '2026-13',
        onSelect: 'a',
        onMonth: 'b'
      })
    ).toBeNull();
    expect(parseViewNode({ type: 'calendar', month: '2026-11' })).toBeNull();

    let deep: Record<string, unknown> = { type: 'heading', text: 'leaf' };
    for (let i = 0; i < 10; i++) deep = { type: 'stack', children: [deep] };
    const flatten = (n: unknown, depth = 0): number =>
      (n as { children?: unknown[] }).children?.length
        ? flatten((n as { children: unknown[] }).children[0], depth + 1)
        : depth;
    expect(flatten(parseViewNode(deep))).toBeLessThan(10);
  });

  it('drops days that are not on the calendar', () => {
    expect(
      parseViewNode({
        type: 'calendar',
        month: '2026-02',
        selected: '2026-02-31',
        days: {
          '2026-02-30': { strong: true },
          '2026-02-28': { strong: true }
        },
        onSelect: 'select',
        onMonth: 'month'
      })
    ).toMatchObject({
      selected: undefined,
      days: { '2026-02-28': { strong: true } }
    });
  });

  it('caps text length so a view cannot grow the sidebar without bound', () => {
    const node = parseViewNode({ type: 'text', text: 'x'.repeat(10_000) });
    expect(node).toMatchObject({ type: 'text' });
    expect((node as { text: string }).text.length).toBe(300);
  });
});

describe('view text', () => {
  it('parses keys and dates, dropping what it cannot resolve safely', () => {
    expect(
      parseViewNode({
        type: 'stack',
        children: [
          {
            type: 'heading',
            text: { key: 'hello', params: { name: 'Ada', 'bad name': 'x' } }
          },
          { type: 'heading', text: { key: '../escape' } },
          { type: 'text', text: { key: 'notes', count: 3 } },
          {
            type: 'heading',
            text: {
              date: '2026-11-19',
              format: { weekday: 'long', hour: 'numeric' }
            }
          },
          { type: 'heading', text: { date: '2026-02-30', format: {} } }
        ]
      })
    ).toEqual({
      type: 'stack',
      children: [
        { type: 'heading', text: { key: 'hello', params: { name: 'Ada' } } },
        {
          type: 'text',
          text: { key: 'notes', params: {}, count: 3 },
          tone: 'default'
        },
        {
          type: 'heading',
          text: { date: '2026-11-19', format: { weekday: 'long' } }
        }
      ]
    });
  });

  it('resolves in the app’s language, with plural forms and parameters', () => {
    locale.language = 'en';
    expect(viewText('p', { key: 'notes', params: {}, count: 1 })).toBe(
      '1 note'
    );
    expect(viewText('p', { key: 'notes', params: {}, count: 1200 })).toBe(
      '1,200 notes'
    );
    expect(viewText('p', { key: 'hello', params: { name: 'Ada' } })).toBe(
      'Hello, Ada'
    );
    expect(
      viewText('p', {
        date: '2026-11-19',
        format: { weekday: 'long', month: 'long', day: 'numeric' }
      })
    ).toBe('Thursday, November 19');

    locale.language = 'de';
    expect(viewText('p', { key: 'notes', params: {}, count: 2 })).toBe(
      '2 Notizen'
    );
    expect(
      viewText('p', {
        date: '2026-11-19',
        format: { weekday: 'long', month: 'long', day: 'numeric' }
      })
    ).toBe('Donnerstag, 19. November');
    // A missing string shows its key rather than nothing.
    expect(viewText('p', { key: 'missing', params: {} })).toBe(
      'plugins.p.missing'
    );
    locale.language = 'en';
  });
});
