// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { buildComponent } from '../lib/build.js';
import { loadPlugin } from '../lib/testing.js';
import { createMockHost } from '../lib/mock-host.js';
let dir: string;
let component: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'batch-sdk-'));
  component = join(dir, 'plugin.wasm');
  await buildComponent({
    source: join(__dirname, 'fixtures/batch/main.ts'),
    out: component
  });
}, 60_000);
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
describe('general host batches', { timeout: 60_000 }, () => {
  it('round-trips mixed typed operations and backward refs through compiled QuickJS Wasm', async () => {
    const plugin = await loadPlugin(component, {
      permissions: ['notes.read', 'pluginStorage.read', 'pluginStorage.write'],
      notes: [{ id: 'n0', title: 'One' }],
      timeZone: 'UTC'
    });
    expect(await plugin.call('run')).toMatchObject([
      { index: 1, value: { tag: 'text', val: '2026-02-28' } },
      {
        index: 4,
        value: { tag: 'optional-text', val: '---\ntitle: "Batch"\n---\n' }
      },
      { index: 5, value: { tag: 'notes', val: [{ id: 'n0', title: 'One' }] } }
    ]);
  });
  it('preserves indexed permission errors through the SDK', async () => {
    const plugin = await loadPlugin(component, {});
    expect(await plugin.call('denied')).toEqual({
      index: 0,
      kind: 'denied',
      detail: 'notes.read'
    });
  });
  it('prevalidates refs and leaves prior writes on runtime failure', () => {
    const host = createMockHost({ permissions: ['pluginStorage.write'] });
    const execute = host.imports['mindstream:plugin/batch@0.1.0'].execute;
    const literal = (val: string) => ({ tag: 'literal', val });
    const write = (name: string) => ({
      operation: {
        tag: 'storage-write',
        val: { path: literal(name), contents: literal('saved') }
      },
      keep: false
    });
    expect(() =>
      execute([
        write('first'),
        {
          operation: { tag: 'frontmatter', val: { tag: 'previous', val: 9 } },
          keep: true
        }
      ])
    ).toThrow();
    expect(host.storage.size).toBe(0);
    try {
      execute([
        write('first'),
        { operation: { tag: 'notes-all' }, keep: true },
        write('later')
      ]);
    } catch (e) {
      expect(e).toMatchObject({
        payload: { index: 1, cause: { tag: 'denied', val: 'notes.read' } }
      });
    }
    expect(host.storage.get('first')).toBe('saved');
    expect(host.storage.has('later')).toBe(false);
  });
});
