import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageError } from './protocol';

type Reply = 'ok' | 'hang' | { error: StorageError };

type Plan = {
  // Thrown by `new Worker(...)`, which is how a CSP block surfaces.
  construct?: Error;
  open?: Reply;
  invoke?: Reply;
};

type Message = { id: number; method: string; args?: unknown };

// Scripted worker: each constructed worker consumes the next plan. Replies are
// queued as microtasks, matching how a real worker answers.
class FakeWorker {
  static instances: FakeWorker[] = [];
  static plans: Plan[] = [];

  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: Message[] = [];
  terminated = false;
  private plan: Plan;

  constructor() {
    this.plan = FakeWorker.plans.shift() ?? {};
    if (this.plan.construct) throw this.plan.construct;
    FakeWorker.instances.push(this);
  }

  postMessage(message: Message) {
    this.messages.push(message);
    const reply =
      message.method === 'open'
        ? (this.plan.open ?? 'ok')
        : message.method === 'invoke'
          ? (this.plan.invoke ?? 'ok')
          : 'ok';
    if (reply === 'hang') return;
    queueMicrotask(() =>
      this.onmessage?.({
        data:
          reply === 'ok'
            ? {
                id: message.id,
                ok: true,
                result: message.method === 'invoke' ? [] : undefined
              }
            : { id: message.id, ok: false, error: reply.error }
      })
    );
  }

  terminate() {
    this.terminated = true;
  }

  invokes() {
    return this.messages.filter((message) => message.method === 'invoke');
  }
}

async function loadVault() {
  vi.resetModules();
  return import('./vault');
}

function outcome(promise: Promise<unknown>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
}

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.plans = [];
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('vault connection recovery', () => {
  it('reuses one healthy worker across calls', async () => {
    const { invokeBrowser } = await loadVault();
    await invokeBrowser('list_notes', {});
    await invokeBrowser('list_notes', {});
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].invokes()).toHaveLength(2);
  });

  it('reconnects on the next call after a worker crash', async () => {
    FakeWorker.plans = [{ invoke: 'hang' }, {}];
    const { invokeBrowser } = await loadVault();

    const crashed = outcome(invokeBrowser('list_notes', {}));
    await vi.waitFor(() =>
      expect(FakeWorker.instances[0].invokes()).toHaveLength(1)
    );
    FakeWorker.instances[0].onerror?.({ message: 'wasm trap' });

    expect(await crashed).toEqual({
      ok: false,
      error: { code: 'worker', message: 'wasm trap' }
    });
    expect(FakeWorker.instances[0].terminated).toBe(true);

    await expect(invokeBrowser('list_notes', {})).resolves.toEqual([]);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('reconnects after a worker crashes while idle', async () => {
    const { invokeBrowser } = await loadVault();
    await invokeBrowser('list_notes', {});

    FakeWorker.instances[0].onerror?.({ message: 'out of memory' });

    await expect(invokeBrowser('list_notes', {})).resolves.toEqual([]);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('reconnects on the next call after a stalled request times out', async () => {
    vi.useFakeTimers();
    FakeWorker.plans = [{ invoke: 'hang' }, {}];
    const { invokeBrowser } = await loadVault();

    const stalled = outcome(invokeBrowser('list_notes', {}));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await stalled).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'timeout' })
    });
    expect(FakeWorker.instances[0].terminated).toBe(true);

    await expect(invokeBrowser('list_notes', {})).resolves.toEqual([]);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('does not resend a timed-out write when reconnecting', async () => {
    vi.useFakeTimers();
    FakeWorker.plans = [{ invoke: 'hang' }, {}];
    const { invokeBrowser } = await loadVault();

    const write = outcome(
      invokeBrowser('save_note', { input: { id: 'n1', body: 'draft' } })
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await write).ok).toBe(false);

    // The outcome of the stalled write is unknown, so it must not be replayed
    // on the replacement worker. Only the first worker ever saw it.
    const all = FakeWorker.instances.flatMap((worker) => worker.invokes());
    expect(all).toHaveLength(1);
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('recovers when the constructor throws on the first attempt', async () => {
    FakeWorker.plans = [{ construct: new Error('Worker blocked by CSP') }, {}];
    const { invokeBrowser } = await loadVault();

    await expect(invokeBrowser('list_notes', {})).rejects.toThrow(
      'Worker blocked by CSP'
    );
    await expect(invokeBrowser('list_notes', {})).resolves.toEqual([]);
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('does not cache a refused open, so the next call retries it', async () => {
    FakeWorker.plans = [
      { open: { error: { code: 'databaseBusy', message: 'Already open' } } },
      {}
    ];
    const { invokeBrowser } = await loadVault();

    expect(await outcome(invokeBrowser('list_notes', {}))).toEqual({
      ok: false,
      error: { code: 'databaseBusy', message: 'Already open' }
    });
    await expect(invokeBrowser('list_notes', {})).resolves.toEqual([]);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('shares one open attempt among concurrent callers and fails them together', async () => {
    FakeWorker.plans = [
      { open: { error: { code: 'io', message: 'OPFS unavailable' } } },
      {}
    ];
    const { invokeBrowser } = await loadVault();

    const results = await Promise.all(
      [1, 2, 3].map(() => outcome(invokeBrowser('list_notes', {})))
    );

    for (const result of results) {
      expect(result).toEqual({
        ok: false,
        error: { code: 'io', message: 'OPFS unavailable' }
      });
    }
    // One worker for three callers: the failed attempt was shared, not repeated.
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.plans).toHaveLength(1);

    await expect(invokeBrowser('list_notes', {})).resolves.toEqual([]);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('shares one successful open among concurrent callers', async () => {
    const { invokeBrowser } = await loadVault();

    await Promise.all([
      invokeBrowser('list_notes', {}),
      invokeBrowser('list_notes', {}),
      invokeBrowser('list_notes', {})
    ]);

    expect(FakeWorker.instances).toHaveLength(1);
  });
});
