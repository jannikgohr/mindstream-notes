// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkPackage } from '../typescript/lib/check.js';
import { loadPlugin } from '../typescript/lib/testing.js';
import type { HostOptions } from '../typescript/lib/testing';

const root = join(import.meta.dirname, '../..');
// Also validate downloaded CI rebuilds with the same package/behavior assertions.
const bundledRoot =
  process.env.MINDSTREAM_TEST_BUNDLED_DIR ?? join(root, 'plugins');
const component = (name: string, language = 'Rust') =>
  language === 'Rust'
    ? join(bundledRoot, name, 'plugin.wasm')
    : join(root, 'plugin-sdk/examples', `${name}-typescript`, 'plugin.wasm');
const now = '2026-07-25T10:00:00Z';

// The TypeScript examples are built from source, not committed.
beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'plugin-sdk/examples/build.mjs')]);
}, 120_000);
const loadTemplates = (language: string, options: HostOptions = {}) =>
  loadPlugin(component('templates', language), {
    now,
    timeZone: 'UTC',
    permissions: ['notes.read', 'notes.create'],
    ...options
  });

// Each test transpiles and instantiates actual components, including on cold CI.
describe.each(['Rust', 'TypeScript'])(
  'Templates component (%s)',
  { timeout: 60_000 },
  (language) => {
    const templates = (options: HostOptions = {}) =>
      loadTemplates(language, options);
    it('interpolates title first, dates, chained offsets, filters and missing variables', async () => {
      const plugin = await templates();
      expect(
        await plugin.call('renderTemplate', {
          title: 'Log {{date:YYYY}}',
          body: '{{title|upper}}\n{{date+7d:YYYY-MM-DD}}\n{{date-1M+2d:YYYY-MM-DD}}\n{{date:dddd, D MMMM}}\n{{word|trim|capitalize}}\n{{word|slug}}\n{{unknown}}\n{{number}}\n{{flag}}\n{{word|unknown}}',
          vars: { word: '  hello WORLD  ', number: 42, flag: false },
          locale: 'de'
        })
      ).toEqual({
        title: 'Log 2026',
        body: 'LOG 2026\n2026-08-01\n2026-06-27\nSamstag, 25 Juli\nHello WORLD\nhello-world\n\n42\nfalse\n  hello WORLD  '
      });
      expect(
        await plugin.call('renderTemplate', {
          title: '{{date}}',
          body: '{{date+1d}} {{time}}',
          date: '2026-12-24T18:30:00Z'
        })
      ).toEqual({ title: '2026-12-24', body: '2026-12-25 18:30' });
      const result = await plugin.call<{ body: string }>('renderTemplate', {
        body: '{{uuid}}\n{{uuid}}'
      });
      const [first, second] = result.body.split('\n');
      expect(first).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(first).not.toBe(second);
      expect(
        await plugin.call('renderTemplate', {
          body: '{{name+999999999999999999999999999999999999999d}}/{{emoji|capitalize}}/{{array}}/{{object}}/{{float}}',
          vars: {
            name: 'Ada',
            emoji: '😀café',
            array: [1, null, true, ['a', 'b']],
            object: {},
            float: 1.0
          }
        })
      ).toEqual({
        title: '',
        body: 'Ada/😀café/1,,true,a,b/[object Object]/1'
      });
    });

    it('finds any note kind by tag or nested folder, sorts and stops on folder cycles', async () => {
      const plugin = await templates({
        settings: { 'source-folder': 'root', 'source-tag': 'template' },
        folders: [
          { id: 'root', name: 'Templates', parentId: null },
          { id: 'child', name: 'Nested', parentId: 'root' },
          { id: 'loop', name: 'Loop', parentId: 'loop' }
        ],
        notes: [
          { id: 'z', title: 'Zulu', folderId: 'child', kind: 'kanban' },
          {
            id: 'a',
            title: 'Alpha',
            tags: ['template'],
            kind: 'plugin.com.mindstream.typst.document'
          },
          { id: 'other', title: 'Other', folderId: 'loop' }
        ]
      });
      expect(await plugin.call('newFromTemplate')).toEqual({
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
      expect(await (await templates()).call('newFromTemplate')).toMatchObject({
        effect: 'toast',
        message: expect.stringContaining('Set a template')
      });
      expect(
        await (
          await templates({ settings: { 'source-tag': 'empty' } })
        ).call('newFromTemplate')
      ).toEqual({ effect: 'toast', message: 'No template notes found.' });
      await expect(
        (
          await templates({
            permissions: [],
            settings: { 'source-tag': 'template' }
          })
        ).call('newFromTemplate')
      ).rejects.toThrow(/notes.read/);
    });
  }
);

describe.each(['Rust', 'TypeScript'])(
  'Typst component (%s)',
  { timeout: 60_000 },
  (language) => {
    const typst = (options: HostOptions = {}) =>
      loadPlugin(component('typst', language), {
        permissions: ['nativeTools.runDeclared'],
        ...options
      });

    it('keeps source editing available without a desktop tool or tool permission', async () => {
      for (const options of [{ tools: { typst: null } }, { permissions: [] }]) {
        const plugin = await typst(options);
        for (const name of ['renderDocument', 'exportDocument']) {
          expect(await plugin.call(name, { body: '= Hello' })).toEqual({
            sourceOnly: true,
            diagnostics: []
          });
        }
      }
    });

    it('sends PDF compile arguments and source, and keeps binary output and diagnostics', async () => {
      const calls: unknown[] = [];
      const plugin = await typst({
        tools: {
          typst: (options) => {
            calls.push(options);
            return {
              stdout: new Uint8Array([37, 80, 68, 70, 0, 255]),
              stderr:
                'warning: careful  \n  context\n\nerror: example\n  details\n'
            };
          }
        }
      });
      const input = { body: '= Hello' };
      const rendered = await plugin.call('renderDocument', input);
      expect(rendered).toEqual({
        preview: { mime: 'application/pdf', dataBase64: 'JVBERgD/' },
        diagnostics: [
          { severity: 'warning', message: 'careful\n  context' },
          { severity: 'error', message: 'example\n  details' }
        ]
      });
      expect(await plugin.call('exportDocument', input)).toEqual(rendered);
      expect(calls).toEqual(
        Array(2).fill({
          args: ['compile', '--format', 'pdf', '-', '-'],
          stdin: '= Hello',
          timeoutMs: 30_000
        })
      );
      const unusual = await typst({
        tools: {
          typst: () => ({
            stderr: 'error: x\u2028\nwarning:\u2028valid\nerror: x\ry'
          })
        }
      });
      expect(await unusual.call('renderDocument')).toMatchObject({
        diagnostics: [
          { severity: 'error', message: 'error: x\u2028' },
          { severity: 'warning', message: 'valid\nerror: x\ry' }
        ]
      });
    });

    it('exports source without a native tool or permission', async () => {
      const plugin = await typst({ permissions: [] });
      for (const body of ['', '= Grüße 😀']) {
        expect(
          await plugin.call('exportDocument', { format: 'typ', body })
        ).toEqual({
          file: { mime: 'text/plain', text: body }
        });
      }
      await expect(
        plugin.call('exportDocument', { format: 'unknown' })
      ).rejects.toThrow(/Unsupported export format: unknown/);
    });

    it('bootstraps image exports with a PDF and compiles each requested page', async () => {
      const calls: unknown[] = [];
      const plugin = await typst({
        tools: {
          typst: (options) => {
            calls.push(options);
            return {
              stdout: new Uint8Array([0, 255]),
              stderr: 'warning: careful'
            };
          }
        }
      });
      for (const format of ['png', 'svg']) {
        expect(
          await plugin.call('exportDocument', { format, body: '= Hello' })
        ).toEqual({
          pagesPdf: { mime: 'application/pdf', dataBase64: 'AP8=' },
          diagnostics: [{ severity: 'warning', message: 'careful' }]
        });
        expect(
          await plugin.call('exportDocument', {
            format,
            body: '= Hello',
            page: 2
          })
        ).toEqual({
          file: {
            mime: format === 'png' ? 'image/png' : 'image/svg+xml',
            dataBase64: 'AP8='
          },
          diagnostics: [{ severity: 'warning', message: 'careful' }]
        });
      }
      expect(calls).toEqual(
        ['png', 'svg'].flatMap((format) => [
          {
            args: ['compile', '--format', 'pdf', '-', '-'],
            stdin: '= Hello',
            timeoutMs: 30_000
          },
          {
            args: ['compile', '--format', format, '--pages', '2', '-', '-'],
            stdin: '= Hello',
            timeoutMs: 30_000
          }
        ])
      );
    });

    it('reports failed compiles and timeouts without returning file bytes', async () => {
      const failed = await typst({
        tools: {
          typst: () => ({
            statusCode: 1,
            stdout: 'discard',
            stderr: 'error: broken\n at line 1'
          })
        }
      });
      expect(await failed.call('renderDocument')).toMatchObject({
        preview: { dataBase64: '' },
        diagnostics: [{ severity: 'error', message: 'broken\n at line 1' }]
      });
      expect(
        await failed.call('exportDocument', { format: 'png', page: 1 })
      ).toEqual({
        file: { mime: 'image/png', dataBase64: '' },
        diagnostics: [{ severity: 'error', message: 'broken\n at line 1' }]
      });
      const timed = await typst({
        tools: { typst: () => ({ timedOut: true }) }
      });
      expect(await timed.call('renderDocument')).toMatchObject({
        preview: { dataBase64: '' },
        diagnostics: [
          { severity: 'error', message: 'Typst timed out while compiling.' }
        ]
      });
      await expect(
        timed.call('exportDocument', { format: 'svg', page: 3 })
      ).rejects.toThrow(/Typst timed out while exporting page 3/);
    });
  }
);

describe('Journal component', { timeout: 60_000 }, () => {
  const journal = (options: HostOptions = {}) =>
    loadPlugin(component('journal'), {
      now: '2026-11-19T10:00:00Z',
      timeZone: 'UTC',
      permissions: ['notes.read', 'notes.create'],
      ...options
    });

  it('asks the host to open or create the day’s note, from the template', async () => {
    const plugin = await journal({
      settings: {
        folder: 'daily',
        'title-format': 'dddd, D MMMM YYYY',
        template: 'tpl'
      }
    });
    expect(
      await plugin.call('onEvent', { event: 'open', value: '2026-11-23' })
    ).toMatchObject({
      effect: {
        effect: 'openOrCreateNote',
        title: 'Monday, 23 November 2026',
        parentId: 'daily',
        template: { sourceNoteId: 'tpl', date: '2026-11-23' }
      }
    });
    await expect(
      plugin.call('onEvent', { event: 'open', value: '23.11.2026' })
    ).rejects.toThrow(/YYYY-MM-DD/);
    expect(await (await journal()).call('openToday')).toEqual({
      effect: 'openOrCreateNote',
      title: '2026-11-19',
      parentId: null
    });
  });

  it('draws the calendar as a schema view and keeps its state in the host', async () => {
    const plugin = await journal({
      settings: { folder: 'daily' },
      notes: [
        {
          id: 'd19',
          title: '2026-11-19',
          folderId: 'daily',
          created: '2026-11-19T08:00:00Z'
        },
        {
          id: 'n19',
          title: 'Ideas',
          folderPath: 'Work',
          created: '2026-11-19T09:00:00Z'
        }
      ]
    });
    type Rendered = {
      state: { month: string; selected: string };
      view: { children: Record<string, unknown>[] };
    };
    const first = await plugin.call<Rendered>('render', { state: null });
    expect(first.state).toEqual({ month: '2026-11', selected: '2026-11-19' });
    const [calendar, heading, list] = first.view.children;
    expect(calendar).toMatchObject({
      type: 'calendar',
      month: '2026-11',
      selected: '2026-11-19',
      days: {
        '2026-11-19': {
          marks: ['accent', 'muted'],
          strong: true,
          title: '1 note'
        }
      }
    });
    expect(heading).toEqual({ type: 'heading', text: 'Thursday, November 19' });
    expect(list.items).toEqual([
      {
        label: '2026-11-19',
        icon: 'icons/calendar.svg',
        tone: 'accent',
        on: { effect: 'openNote', noteId: 'd19' }
      },
      {
        label: 'Ideas',
        noteKind: 'markdown',
        detail: 'Work',
        on: { effect: 'openNote', noteId: 'n19', preview: true }
      }
    ]);

    expect(
      await plugin.call('onEvent', {
        state: first.state,
        event: 'select',
        value: '2026-12-02'
      })
    ).toEqual({
      state: { month: '2026-12', selected: '2026-12-02' },
      effect: {
        effect: 'openOrCreateNote',
        title: '2026-12-02',
        parentId: 'daily'
      }
    });
    expect(
      await plugin.call('onEvent', {
        state: first.state,
        event: 'month',
        value: '2027-01'
      })
    ).toEqual({
      state: { month: '2027-01', selected: '2026-11-19' },
      effect: null
    });
    const empty = await plugin.call<Rendered>('render', {
      state: { month: '2026-12', selected: '2026-12-02' }
    });
    expect(empty.view.children[2].items).toEqual([
      {
        label: 'Create daily note',
        icon: 'icons/calendar.svg',
        tone: 'muted',
        on: { event: 'open', value: '2026-12-02' }
      }
    ]);
  });

  it('marks daily notes and counts the other notes created or edited each day', async () => {
    const plugin = await journal({
      settings: { folder: 'daily' },
      notes: [
        {
          id: 'd19',
          title: '2026-11-19',
          folderId: 'daily',
          folderPath: 'Daily',
          created: '2026-11-19T08:00:00Z'
        },
        {
          id: 'loose',
          title: '2026-11-20',
          folderPath: '',
          created: '2026-11-20T08:00:00Z',
          modified: '2026-11-21T08:00:00Z'
        },
        {
          id: 'n19',
          title: 'Ideas',
          folderId: 'work',
          folderPath: 'Areas / Work',
          created: '2026-11-19T09:00:00Z'
        }
      ]
    });
    type Calendar = {
      days: Record<string, { marks: string[]; strong: boolean }>;
    };
    const { view } = await plugin.call<{
      view: { children: [Calendar, unknown, { items: unknown[] }] };
    }>('render', { state: { month: '2026-11', selected: '2026-11-19' } });
    const [calendar, , list] = view.children;
    // A daily note outside the folder is an ordinary note; an edit counts on
    // the day it happened too.
    expect(calendar.days).toEqual({
      '2026-11-19': {
        marks: ['accent', 'muted'],
        strong: true,
        title: '1 note'
      },
      '2026-11-20': { marks: ['muted'], strong: false, title: '1 note' },
      '2026-11-21': { marks: ['muted'], strong: false, title: '1 note' }
    });
    expect(list.items).toEqual([
      expect.objectContaining({ label: '2026-11-19', tone: 'accent' }),
      expect.objectContaining({ label: 'Ideas', detail: 'Work' })
    ]);
  });
});

it('both builtin packages pass SDK preflight with unchanged contribution IDs', async () => {
  for (const name of ['templates', 'typst']) {
    const dir = join(bundledRoot, name);
    expect(await checkPackage(dir)).toEqual([]);
    const manifest = JSON.parse(
      await readFile(join(dir, 'manifest.json'), 'utf8')
    );
    expect(manifest).toMatchObject({
      manifestVersion: 2,
      runtime: 'wasm',
      entry: 'plugin.wasm'
    });
    expect((await readFile(component(name))).length).toBeLessThan(256 * 1024);
    const plugin = await loadPlugin(component(name));
    expect(await plugin.exports()).toEqual(
      name === 'templates'
        ? ['newFromTemplate', 'renderTemplate']
        : ['renderDocument', 'exportDocument']
    );
    expect(await readdir(dir, { recursive: true })).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\.(ts|rs)$/)])
    );
    expect(
      await checkPackage(
        join(root, 'plugin-sdk/examples', `${name}-typescript`)
      )
    ).toEqual([]);
  }
}, 60_000);

it('every shipped plugin uses v2 and LanguageTool stays declarative', async () => {
  const shippedRoot = join(root, 'plugins');
  const directories = (await readdir(shippedRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(directories).toEqual([
    'journal',
    'languagetool',
    'templates',
    'typst'
  ]);
  for (const name of directories) {
    const dir = join(shippedRoot, name);
    const manifest = JSON.parse(
      await readFile(join(dir, 'manifest.json'), 'utf8')
    );
    expect(manifest.manifestVersion).toBe(2);
    expect(manifest.runtime).toBe(
      name === 'languagetool' ? 'manifest-only' : 'wasm'
    );
    if (name === 'languagetool') {
      expect(manifest.entry).toBeUndefined();
      expect(manifest.permissions).toEqual(['textCheckers.contribute']);
      expect(manifest.contributes.textCheckers[0].id).toBe('grammar');
    }
    expect(await readdir(dir, { recursive: true })).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\.(ts|rs)$/)])
    );
  }
}, 60_000);
