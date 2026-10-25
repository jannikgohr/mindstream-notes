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
      detail: 'notes.read',
      phase: 'execution',
      completed: 0,
      replies: []
    });
  });
  it('returns recoverable prefix results through the compiled SDK, with no effects on validation failure', async () => {
    const plugin = await loadPlugin(component, {
      permissions: ['pluginStorage.write']
    });
    expect(await plugin.call('recover', { validation: true })).toEqual({
      index: 2,
      kind: 'invalid',
      phase: 'validation',
      completed: 0,
      replies: []
    });
    expect(plugin.storage.size).toBe(0);
    expect(await plugin.call('recover', { validation: false })).toEqual({
      index: 2,
      kind: 'denied',
      phase: 'execution',
      completed: 2,
      replies: [
        { index: 0, value: { tag: 'text', val: '---\ntitle: "Saved"\n---\n' } }
      ]
    });
    expect(plugin.storage.get('checkpoint.txt')).toBe(
      '---\ntitle: "Saved"\n---\n'
    );
  });
  it('reports the successful handler whose oversized result was rejected', () => {
    const host = createMockHost({});
    const execute = host.imports['mindstream:plugin/batch@0.1.0'].execute;
    expect(() =>
      execute(
        Array.from({ length: 128 }, (_, i) => ({
          operation: { tag: 'random-bytes', val: 65536 },
          keep: i === 0 || i === 127
        }))
      )
    ).toThrow(
      expect.objectContaining({
        payload: expect.objectContaining({
          index: 127,
          phase: 'result-limit',
          completed: 128,
          replies: [
            { index: 0, value: { tag: 'bytes', val: expect.any(Uint8Array) } }
          ]
        })
      })
    );
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
    ).toThrow(
      expect.objectContaining({
        payload: expect.objectContaining({
          index: 1,
          phase: 'validation',
          completed: 0,
          replies: []
        })
      })
    );
    expect(host.storage.size).toBe(0);
    try {
      execute([
        write('first'),
        { operation: { tag: 'notes-all' }, keep: true },
        write('later')
      ]);
    } catch (e) {
      expect(e).toMatchObject({
        payload: {
          index: 1,
          phase: 'execution',
          completed: 1,
          replies: [],
          cause: { tag: 'denied', val: 'notes.read' }
        }
      });
    }
    expect(host.storage.get('first')).toBe('saved');
    expect(host.storage.has('later')).toBe(false);
  });
});
