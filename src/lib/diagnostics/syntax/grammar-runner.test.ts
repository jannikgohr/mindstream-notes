import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  grammarFaulted,
  resetGrammarRunner,
  runGrammar
} from './grammar-runner';
import { createGrammarSyntax, type DiagnosticGrammar } from './grammar';
import type { GrammarRequest, GrammarResponse } from './grammar-protocol';

/**
 * How the stand-in Worker behaves for the test in hand. Module-level rather
 * than per-instance because the runner constructs the Worker itself.
 */
let mode: 'answer' | 'hang' | 'throw' = 'answer';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: GrammarResponse }) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(request: GrammarRequest) {
    // A hanging worker is the whole point of the module: it stands in for a
    // pattern that is still backtracking and never going to return.
    if (mode === 'hang') return;
    const data: GrammarResponse =
      mode === 'throw'
        ? { id: request.id, error: 'bad pattern' }
        : { id: request.id, ranges: [{ from: 0, to: 4 }] };
    queueMicrotask(() => this.onmessage?.({ data }));
  }

  terminate() {
    this.terminated = true;
  }
}

const withWorker = () => {
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
};
const withoutWorker = () => {
  delete (globalThis as { Worker?: unknown }).Worker;
};

beforeEach(() => {
  mode = 'answer';
  FakeWorker.instances = [];
  resetGrammarRunner();
});

afterEach(() => {
  withoutWorker();
  resetGrammarRunner();
  vi.useRealTimers();
});

/** A fresh object each time — faulting is tracked per grammar identity. */
const grammar = (): DiagnosticGrammar => ({
  lineComments: ['%'],
  ignorePatterns: ['x+']
});

describe('runGrammar', () => {
  it('returns the worker’s ranges when it answers', async () => {
    withWorker();
    await expect(runGrammar(grammar(), 'text')).resolves.toEqual([
      { from: 0, to: 4 }
    ]);
  });

  it('reuses one worker across calls', async () => {
    withWorker();
    await runGrammar(grammar(), 'a');
    await runGrammar(grammar(), 'b');
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('declines when the environment has no worker', async () => {
    // SSR and the test runner. Patterns are simply not run — falling back to
    // inline execution would discard the one property this module provides.
    withoutWorker();
    await expect(runGrammar(grammar(), 'text')).resolves.toBeNull();
  });

  it('terminates a worker that overruns its budget', async () => {
    vi.useFakeTimers();
    withWorker();
    mode = 'hang';
    const g = grammar();
    const pending = runGrammar(g, 'text');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBeNull();
    // Terminating is the only thing that stops a running match; without it the
    // editor thread would be waiting on a worker that never replies.
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(grammarFaulted(g)).toBe(true);
  });

  it('does not ask a faulted grammar again', async () => {
    vi.useFakeTimers();
    withWorker();
    mode = 'hang';
    const g = grammar();
    const pending = runGrammar(g, 'text');
    await vi.advanceTimersByTimeAsync(1000);
    await pending;

    // One bad pattern costs one timeout, not one per keystroke for the rest of
    // the session.
    mode = 'answer';
    await expect(runGrammar(g, 'text')).resolves.toBeNull();
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('faults a grammar whose patterns throw inside the worker', async () => {
    withWorker();
    mode = 'throw';
    const g = grammar();
    await expect(runGrammar(g, 'text')).resolves.toBeNull();
    expect(grammarFaulted(g)).toBe(true);
  });

  it('settles callers queued behind a termination', async () => {
    vi.useFakeTimers();
    withWorker();
    mode = 'hang';
    const first = runGrammar(grammar(), 'a');
    const second = runGrammar(grammar(), 'b');
    await vi.advanceTimersByTimeAsync(1000);
    // Both resolve rather than hanging: the thread they were waiting on is gone.
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
  });
});

describe('createGrammarSyntax fallback', () => {
  it('degrades to the delimiters and reports once', async () => {
    withoutWorker();
    const faults: string[] = [];
    const syntax = createGrammarSyntax(grammar(), (r) => faults.push(r));

    const text = 'keep xxx % dropped';
    // The line comment still applies; only the `x+` pattern is lost.
    await expect(syntax.ignoreRanges(text)).resolves.toEqual([
      { from: 9, to: 18 }
    ]);
    await syntax.ignoreRanges(text);

    // Once, not once per keystroke — the fallback happens on every check.
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatch(/delimiters/);
  });

  it('stays synchronous when a grammar declares no patterns', () => {
    withoutWorker();
    const syntax = createGrammarSyntax({ lineComments: ['%'] });
    // Not a promise: delimiters are bounded work and never leave the thread.
    expect(syntax.ignoreRanges('a % b')).toEqual([{ from: 2, to: 5 }]);
  });
});
