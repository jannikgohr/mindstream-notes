// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPackage } from '../typescript/lib/check.js';
import { loadPlugin } from '../typescript/lib/testing.js';
import type { HostOptions } from '../typescript/lib/testing';

const root = join(import.meta.dirname, '../..');
const component = (name: string) => join(root, 'plugins', name, 'plugin.wasm');
const now = '2026-07-25T10:00:00Z';
const templates = (options: HostOptions = {}) =>
  loadPlugin(component('templates'), {
    now,
    timeZone: 'UTC',
    permissions: ['notes.read', 'notes.create'],
    ...options
  });

// Each test transpiles and instantiates actual components, including on cold CI.
describe('bundled Templates component', { timeout: 60_000 }, () => {
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
    const result = await plugin.call<{ body: string }>('renderTemplate', {
      body: '{{uuid}}\n{{uuid}}'
    });
    const [first, second] = result.body.split('\n');
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(first).not.toBe(second);
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
});

describe('bundled Typst component', { timeout: 60_000 }, () => {
  const typst = (options: HostOptions = {}) =>
    loadPlugin(component('typst'), {
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
    const timed = await typst({ tools: { typst: () => ({ timedOut: true }) } });
    expect(await timed.call('renderDocument')).toMatchObject({
      preview: { dataBase64: '' },
      diagnostics: [
        { severity: 'error', message: 'Typst timed out while compiling.' }
      ]
    });
  });
});

it('both builtin packages pass SDK preflight with unchanged contribution IDs', async () => {
  for (const name of ['templates', 'typst']) {
    const dir = join(root, 'plugins', name);
    expect(await checkPackage(dir)).toEqual([]);
    const manifest = JSON.parse(
      await readFile(join(dir, 'manifest.json'), 'utf8')
    );
    expect(manifest).toMatchObject({
      manifestVersion: 2,
      runtime: 'wasm',
      entry: 'plugin.wasm'
    });
  }
}, 60_000);
