// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildComponent } from '../lib/build.js';
import { checkPackage } from '../lib/check.js';
import { createProject } from '../lib/create.js';
import { componentInterface } from '../lib/inspect.js';
import { packagePlugin } from '../lib/package.js';
import { loadPlugin } from '../lib/testing.js';

const fixture = join(__dirname, 'fixtures', 'hello');
let work: string;
let component: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'mindstream-sdk-test-'));
  component = join(work, 'plugin.wasm');
  await buildComponent({
    source: join(fixture, 'src', 'main.ts'),
    out: component
  });
}, 60_000);

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

// Component builds/transpilation include compiler startup on cold CI workers.
describe('a TypeScript plugin built with the SDK', { timeout: 60_000 }, () => {
  it('imports only mindstream:plugin interfaces and exports invoke', async () => {
    const { imports, exports } = await componentInterface(
      new Uint8Array(await readFile(component))
    );
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((name) => name.startsWith('mindstream:plugin/'))).toBe(
      true
    );
    expect(exports).toContain('invoke');
  });

  it('runs against the test host with storage, notes, the clock and console', async () => {
    const plugin = await loadPlugin(component, {
      permissions: ['notes.read', 'pluginStorage.read', 'pluginStorage.write'],
      notes: [
        { id: 'n1', title: 'One' },
        { id: 'n2', title: 'Two' }
      ],
      now: '2026-07-25T10:00:00Z',
      timeZone: 'UTC'
    });
    expect(await plugin.call('greet', { locale: 'de' })).toEqual({
      effect: 'toast',
      message: '2 NOTES, VISIT 1, SAMSTAG'
    });
    // Storage carries across calls; instance state does not.
    expect(await plugin.call('greet')).toMatchObject({
      message: '2 NOTES, VISIT 2, SATURDAY'
    });
    expect(plugin.storage.get('visits.json')).toBe('2');
    expect(plugin.logs).toContainEqual({
      level: 'info',
      message: 'greeting {"visits":1}'
    });
    expect(await plugin.exports()).toEqual([
      'context',
      'denied',
      'greet',
      'later',
      'throwsObject'
    ]);
  });

  it('keeps backend context authoritative, including for non-object inputs', async () => {
    const plugin = await loadPlugin(component, {
      now: '2026-07-25T10:00:00Z',
      settings: { real: true },
      folders: [{ id: 'secret', name: 'Secret', parentId: null }]
    });
    const context = {
      settings: { real: true },
      folders: [],
      now: '2026-07-25T10:00:00.000Z'
    };
    expect(
      await plugin.call('context', {
        settings: { fake: true },
        folders: ['spoofed'],
        now: '1900-01-01',
        locale: 'de'
      })
    ).toEqual({ ...context, activeNoteId: null, locale: 'de' });
    for (const input of [null, [], 1, 'text']) {
      expect(await plugin.call('context', input)).toEqual(context);
    }
  });

  it('turns a refused host call into a HostError the plugin can catch', async () => {
    const plugin = await loadPlugin(component);
    expect(await plugin.call('denied')).toBe('denied:nativeTools.runDeclared');
  });

  it('reports unknown exports, promises and thrown non-errors as call errors', async () => {
    const plugin = await loadPlugin(component);
    await expect(plugin.call('nope')).rejects.toThrow(
      /no export "nope" \(it has: context, denied, greet, later, throwsObject\)/
    );
    await expect(plugin.call('later')).rejects.toThrow(/returned a promise/);
    await expect(plugin.call('throwsObject')).rejects.toThrow(
      /"reason":"object"/
    );
  });

  it('packages and checks', async () => {
    const out = join(work, 'package');
    const files = await packagePlugin({ root: fixture, component, out });
    expect(files.sort()).toEqual(
      [
        'docs/guide.de.md',
        'docs/guide.md',
        'icons/hello.svg',
        'manifest.json',
        'plugin.wasm'
      ].sort()
    );
    expect(await checkPackage(out)).toEqual([]);

    const manifest = JSON.parse(
      await readFile(join(out, 'manifest.json'), 'utf8')
    );
    manifest.contributes.toolbar[0].action.export = 'missing';
    manifest.permissions.push('everything.allowed');
    manifest.id = 'Not.Valid';
    await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest));
    const problems = await checkPackage(out);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unknown permission "everything.allowed"/),
        expect.stringMatching(/must be dotted and lowercase/),
        expect.stringMatching(
          /export "missing", which the plugin does not define/
        )
      ])
    );
  }, 30_000);
});

describe('create', { timeout: 60_000 }, () => {
  it('writes a starter project with the id and name filled in', async () => {
    const target = join(work, 'my-plugin');
    const files = await createProject(target, {
      id: 'com.example.mine',
      name: 'My "plugin"',
      sdk: 'file:../sdk'
    });
    expect(files).toEqual(
      expect.arrayContaining([
        '.gitignore',
        'manifest.json',
        'package.json',
        'src/main.ts',
        'test/plugin.test.js'
      ])
    );
    const manifest = JSON.parse(
      await readFile(join(target, 'manifest.json'), 'utf8')
    );
    expect(manifest).toMatchObject({
      id: 'com.example.mine',
      name: 'My "plugin"',
      runtime: 'wasm',
      manifestVersion: 2
    });
    const pkg = JSON.parse(
      await readFile(join(target, 'package.json'), 'utf8')
    );
    expect(pkg.devDependencies['@mindstream/plugin-sdk']).toBe('file:../sdk');
    await expect(createProject(target)).rejects.toThrow(/is not empty/);
    await expect(
      createProject(join(work, 'bad'), { id: 'nodots' })
    ).rejects.toThrow(/not a valid plugin id/);
    expect((await readdir(join(work, 'bad')).catch(() => [])).length).toBe(0);
  });

  it('refuses unsafe entries and output folders before changing existing files', async () => {
    const root = join(work, 'unsafe');
    await createProject(root);
    const manifestPath = join(root, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const out = join(work, 'safe-output');
    manifest.entry = '../escape.wasm';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(packagePlugin({ root, component, out })).rejects.toThrow(
      /plain .wasm file/
    );
    manifest.entry = 'plugin.wasm';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(packagePlugin({ root, component, out: root })).rejects.toThrow(
      /must not contain/
    );
    await expect(packagePlugin({ root, component, out: work })).rejects.toThrow(
      /must not contain/
    );
    manifest.icon = '../outside.svg';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(packagePlugin({ root, component, out })).rejects.toThrow(
      /unsafe path/
    );
    expect(JSON.parse(await readFile(manifestPath, 'utf8')).id).toBe(
      manifest.id
    );
  });

  it('builds the starter as it is written', async () => {
    const target = join(work, 'starter');
    await createProject(target);
    const out = join(target, 'dist', 'plugin.wasm');
    // The starter's own import must resolve, so build it from inside the repo
    // the way the template's `npm run build` would, then run its test case.
    await buildComponent({ source: join(target, 'src', 'main.ts'), out });
    const plugin = await loadPlugin(out, {
      now: '2026-07-25T10:00:00Z',
      timeZone: 'UTC'
    });
    expect(await plugin.call('insertToday', { locale: 'de' })).toEqual({
      effect: 'insertMarkdown',
      markdown: 'Samstag, 25 Juli 2026'
    });
  }, 60_000);
});
