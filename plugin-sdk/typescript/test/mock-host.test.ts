// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  addToDate,
  createMockHost,
  formatDate,
  frontmatter,
  rfc3339,
  storageSegments
} from '../lib/mock-host.js';

// The same vectors as the Rust host's `dates` tests.
const fixed = new Date(Date.UTC(2026, 6, 25, 14, 5, 9));

function refused(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return (error as { payload?: unknown }).payload;
  }
  throw new Error('expected a refusal');
}

describe('the mock host matches the app host', () => {
  it('formats the same tokens', () => {
    expect(formatDate(fixed, 'YYYY-MM-DD HH:mm:ss', 'en', true)).toBe(
      '2026-07-25 14:05:09'
    );
    expect(formatDate(fixed, 'dddd, MMMM D', 'en', true)).toBe(
      'Saturday, July 25'
    );
    expect(formatDate(fixed, 'hh:mm A', 'en', true)).toBe('02:05 PM');
    expect(formatDate(fixed, 'h:m:s a', 'en', true)).toBe('2:5:9 pm');
    expect(formatDate(fixed, 'YY M ddd MMM H', 'en', true)).toBe(
      '26 7 Sat Jul 14'
    );
    expect(formatDate(fixed, '[Week] YYYY', 'en', true)).toBe('Week 2026');
    expect(formatDate(fixed, 'dddd, D. MMMM', 'de', true)).toBe(
      'Samstag, 25. Juli'
    );
    expect(formatDate(fixed, 'ddd MMM', 'de-AT', true)).toBe('Sa Jul');
    const midnight = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(formatDate(midnight, 'h A', 'en', true)).toBe('12 AM');
  });

  it('adds months by clamping to the target month', () => {
    const jan31 = new Date(Date.UTC(2026, 0, 31, 9));
    const fmt = (d: Date) => formatDate(d, 'YYYY-MM-DD HH:mm:ss', 'en', true);
    expect(fmt(addToDate(jan31, 1, 'month', true))).toBe('2026-02-28 09:00:00');
    expect(
      fmt(addToDate(new Date(Date.UTC(2028, 0, 31, 9)), 1, 'month', true))
    ).toBe('2028-02-29 09:00:00');
    expect(fmt(addToDate(jan31, -1, 'year', true))).toBe('2025-01-31 09:00:00');
    expect(fmt(addToDate(jan31, 2, 'week', true))).toBe('2026-02-14 09:00:00');
    expect(fmt(addToDate(fixed, 1, 'minute', true))).toBe(
      '2026-07-25 14:06:09'
    );
  });

  it('writes RFC 3339 with an offset', () => {
    expect(rfc3339(fixed, true)).toBe('2026-07-25T14:05:09+00:00');
    expect(rfc3339(fixed, false)).toMatch(
      /^2026-07-2\dT\d\d:05:09[+-]\d\d:\d\d$/
    );
  });

  it('writes frontmatter with sorted keys, as the host does', () => {
    expect(
      frontmatter(
        JSON.stringify({
          title: 'Hi "there"\nyou',
          tags: ['a', 1, true, null],
          nested: { b: 1, a: 2 }
        })
      )
    ).toBe(
      '---\nnested: {"a":2,"b":1}\ntags:\n  - "a"\n  - 1\n  - true\n  - \ntitle: "Hi \\"there\\"\\nyou"\n---\n'
    );
    expect(refused(() => frontmatter('[1]'))).toEqual({
      tag: 'invalid',
      val: 'frontmatter expects an object'
    });
  });

  it('refuses the storage paths the host refuses', () => {
    expect(storageSegments('cache/compiler.json', false)).toEqual([
      'cache',
      'compiler.json'
    ]);
    expect(storageSegments('', true)).toEqual([]);
    for (const bad of [
      '../escape',
      'cache/../escape',
      '/absolute',
      'a\\b',
      '',
      'a b'
    ]) {
      expect(
        refused(() => storageSegments(bad, false)),
        bad
      ).toMatchObject({ tag: 'invalid' });
    }
  });

  it('checks permissions and keeps storage in memory', () => {
    const host = createMockHost({
      permissions: ['pluginStorage.read', 'pluginStorage.write']
    });
    const storage = host.imports['mindstream:plugin/storage@0.1.0'];
    expect(
      refused(() => host.imports['mindstream:plugin/notes@0.1.0'].all())
    ).toEqual({
      tag: 'denied',
      val: 'notes.read'
    });
    expect(storage.read('a.json')).toBeUndefined();
    storage.write('dir/a.json', '{}');
    storage.write('b.txt', 'hi');
    expect(storage.list('')).toEqual([
      { name: 'b.txt', isDir: false, sizeBytes: 2n },
      { name: 'dir', isDir: true, sizeBytes: 0n }
    ]);
    storage.delete('dir');
    expect(storage.read('dir/a.json')).toBeUndefined();
    expect(
      refused(() => storage.write('big', 'x'.repeat(4 * 1024 * 1024 + 1)))
    ).toMatchObject({
      tag: 'invalid'
    });
    const none = createMockHost({
      permissions: ['pluginStorage.read'],
      dataDirectory: false
    });
    expect(
      refused(() => none.imports['mindstream:plugin/storage@0.1.0'].read('x'))
    ).toMatchObject({
      tag: 'unavailable'
    });
  });

  it('runs declared tools and refuses the rest', () => {
    const host = createMockHost({
      permissions: ['nativeTools.runDeclared'],
      tools: { echo: ({ stdin }) => ({ stdout: stdin ?? '' }), missing: null }
    });
    const tools = host.imports['mindstream:plugin/native-tools@0.1.0'];
    expect(tools.available('echo')).toBe(true);
    expect(tools.available('missing')).toBe(false);
    const run = (id: string, outputBase64 = false) =>
      tools.run(id, {
        args: [],
        stdin: 'hi',
        timeoutMs: undefined,
        outputBase64
      });
    expect(run('echo')).toMatchObject({ stdout: 'hi', statusCode: 0 });
    expect(run('echo', true)).toMatchObject({
      stdout: '',
      stdoutBase64: 'aGk='
    });
    expect(refused(() => run('missing'))).toMatchObject({ tag: 'unavailable' });
    expect(refused(() => run('other'))).toMatchObject({ tag: 'invalid' });
  });
});
