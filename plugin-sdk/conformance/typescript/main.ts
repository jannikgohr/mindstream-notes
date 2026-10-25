/**
 * The TypeScript twin of `../rust`: the same exports, the same report.
 *
 * The runtime's tests run both components against the same expectations, so
 * a difference between what the SDK makes of a host call and what a Rust
 * plugin sees fails there. Built with the SDK by `../build.mjs`.
 */

import {
  clock,
  definePlugin,
  HostError,
  markdown,
  nativeTools,
  notes,
  hasPermission,
  log,
  randomBytes,
  storage,
  uuid
} from '@mindstream/plugin-sdk';
import type { NoteMeta } from '@mindstream/plugin-sdk';

type Outcome = { ok: unknown } | { err: { kind: string; message: string } };

function outcome<T>(
  run: () => T,
  ok: (value: T) => unknown = (v) => v
): Outcome {
  try {
    return { ok: ok(run()) };
  } catch (error) {
    if (error instanceof HostError) {
      return { err: { kind: error.kind, message: error.detail } };
    }
    throw error;
  }
}

const nullable = <T>(value: T | undefined): T | null => value ?? null;

function noteJson(n: NoteMeta) {
  return {
    id: n.id,
    title: n.title,
    tags: n.tags,
    kind: n.kind,
    folderId: n.folderId,
    folderPath: n.folderPath
  };
}

function report(input: { tool?: string }) {
  log('conformance report');
  const fixed = '2026-07-25T10:00:00Z';
  const permissions = Object.fromEntries(
    (
      [
        'notes.read',
        'pluginStorage.read',
        'pluginStorage.write',
        'nativeTools.runDeclared'
      ] as const
    ).map((p) => [p, hasPermission(p)])
  );
  return {
    uuidLength: uuid().length,
    randomLength: randomBytes(16).length,
    permissions,
    clock: {
      nowMillisIsRecent: clock.nowMillis() > 1_700_000_000_000,
      nowHasOffset: clock.now().includes('T'),
      format: outcome(() => clock.format(fixed, 'YYYY', 'en')),
      monthName: outcome(() =>
        clock.format('2026-07-15T12:00:00Z', 'MMMM', 'de')
      ),
      addMonth: outcome(() =>
        clock.format(clock.add(fixed, 1, 'month'), 'YYYY-MM')
      ),
      badTimestamp: outcome(() => clock.format('not a date', 'YYYY'))
    },
    frontmatter: outcome(() =>
      markdown.frontmatter({ title: 'Hi', tags: ['a', 'b'] })
    ),
    notes: {
      all: outcome(
        () => notes.all(),
        (all) => all.map(noteJson)
      ),
      get: outcome(
        () => notes.get('n1'),
        (n) => (n ? noteJson(n) : null)
      ),
      missing: outcome(
        () => notes.get('no-such-note'),
        (n) => n === undefined
      )
    },
    storage: {
      readBefore: outcome(() => nullable(storage.read('state.json'))),
      write: outcome(
        () => storage.write('dir/state.json', '{"n":1}'),
        () => null
      ),
      readAfter: outcome(() => nullable(storage.read('dir/state.json'))),
      list: outcome(() => storage.list('dir')),
      escape: outcome(
        () => storage.write('../escape.txt', 'x'),
        () => null
      ),
      delete: outcome(
        () => storage.delete('dir'),
        () => null
      ),
      readDeleted: outcome(() => nullable(storage.read('dir/state.json')))
    },
    tools: {
      available: outcome(() => nativeTools.available(input.tool ?? 'echo')),
      undeclared: outcome(
        () => nativeTools.run('not-declared'),
        () => null
      )
    }
  };
}

function menu(input: { settings?: { tag?: string } }) {
  const tag = input.settings?.tag ?? 'template';
  const items = notes
    .all()
    .filter((n) => n.tags.includes(tag))
    .map((n) => ({
      label: n.title,
      run: { effect: 'createNoteFromNote' as const, sourceNoteId: n.id }
    }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  if (items.length === 0) {
    return { effect: 'toast', message: 'No template notes found.' };
  }
  return { effect: 'openMenu', items };
}

function runTool(input: {
  tool?: string;
  args?: string[];
  stdin?: string;
  timeoutMs?: number;
  outputBase64?: boolean;
}) {
  return outcome(
    () =>
      nativeTools.run(input.tool ?? 'echo', {
        args: input.args,
        stdin: input.stdin,
        timeoutMs: input.timeoutMs,
        outputBase64: input.outputBase64
      }),
    (out) => ({
      statusCode: out.statusCode,
      stdout: out.stdout,
      stdoutBase64: out.stdoutBase64 ?? null,
      stderr: out.stderr,
      timedOut: out.timedOut
    })
  );
}

let calls = 0;

const handlers = definePlugin({
  echo: (input) => input,
  counter: () => ++calls,
  report,
  menu,
  runTool,
  fail: () => {
    throw new Error('boom');
  },
  bigOutput: (input: { bytes?: number }) => 'x'.repeat(input.bytes ?? 0),
  spin: () => {
    let n = 0;
    for (;;) n = (n + 1) | 0;
  },
  grow: () => {
    const held: number[][] = [];
    for (;;) held.push(new Array(1 << 18).fill(1));
  },
  toolLoop: (input: { tool?: string }) => {
    for (;;) {
      try {
        nativeTools.run(input.tool ?? 'echo', { timeoutMs: 100 });
      } catch {
        // Tool errors are expected; only the deadline may end this.
      }
    }
  },
  randomTooMuch: () => randomBytes(1 << 20).length,
  dateNow: () => ({ now: Date.now(), constructed: new Date().getTime() }),
  random: () => [Math.random(), Math.random()]
});

/** The SDK's dispatcher, plus one export that breaks the JSON contract. */
export function invoke(exportName: string, input: string): string {
  if (exportName === 'notJson') return 'this is not json';
  return handlers(exportName, input);
}
