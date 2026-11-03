import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageError } from './protocol';

type Reply = 'ok' | 'hang' | { error: StorageError };

type Plan = {
  // Thrown by `new Worker(...)`, which is how a CSP block surfaces.
  construct?: Error;
  open?: Reply;
  reset?: Reply;
  invoke?: Reply;
  backup?: Reply;
  import?: Reply;
  notes?: Reply;
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
        : message.method === 'resetTestVault'
          ? (this.plan.reset ?? 'ok')
          : message.method === 'invoke'
            ? (this.plan.invoke ?? 'ok')
            : message.method === 'backup'
              ? (this.plan.backup ?? 'ok')
              : message.method.startsWith('import')
                ? (this.plan.import ?? 'ok')
                : message.method.startsWith('notes')
                  ? (this.plan.notes ?? 'ok')
                  : 'ok';
    if (reply === 'hang') return;
    queueMicrotask(() =>
      this.onmessage?.({
        data:
          reply === 'ok'
            ? {
                id: message.id,
                ok: true,
                result:
                  message.method === 'invoke'
                    ? []
                    : message.method === 'importRestore'
                      ? true
                      : undefined
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
  // The fresh module graph has its own storage gate. Open it, and let a
  // reconnect reopen it the way the tree store's reload does in the app.
  const access = await import('$lib/storage/vault-access.svelte');
  access.resetVaultAccessForTests('ready');
  access.registerVaultAccessProbe(async () => access.markVaultReady());
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
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
  sessionStorage.clear();
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

  it('gives a backup minutes, then still catches a stalled worker', async () => {
    vi.useFakeTimers();
    FakeWorker.plans = [{ backup: 'hang' }];
    const { backupBrowserVault } = await loadVault();

    const stalled = outcome(backupBrowserVault());
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(FakeWorker.instances[0].terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(await stalled).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'timeout' })
    });
    expect(FakeWorker.instances[0].terminated).toBe(true);
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

describe('backup import', () => {
  it('sends each step to the worker with what it needs', async () => {
    const vault = await loadVault();
    const archive = new Blob(['zip']);

    await vault.stageBrowserBackup(archive);
    await vault.mergeBrowserBackup('token');
    await expect(vault.restoreBrowserBackup('token', false)).resolves.toBe(
      true
    );
    await vault.discardBrowserBackup('token');

    expect(
      FakeWorker.instances[0].messages
        .filter((message) => message.method.startsWith('import'))
        .map(({ method, args }) => ({ method, args }))
    ).toEqual([
      { method: 'importBegin', args: { archive } },
      { method: 'importMerge', args: { token: 'token' } },
      { method: 'importRestore', args: { token: 'token', sameAccount: false } },
      { method: 'importCleanup', args: { token: 'token' } }
    ]);
  });

  // The 30-second default would terminate a healthy worker on a large vault.
  it.each([
    ['staging', 'stageBrowserBackup', [new Blob(['zip'])]],
    ['merging', 'mergeBrowserBackup', ['token']],
    ['restoring', 'restoreBrowserBackup', ['token', false]]
  ] as const)('gives %s a backup minutes', async (_, name, args) => {
    vi.useFakeTimers();
    FakeWorker.plans = [{ import: 'hang' }];
    const vault = await loadVault();
    const call = vault[name] as (...args: unknown[]) => Promise<unknown>;

    const stalled = outcome(call(...args));
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(FakeWorker.instances[0].terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(await stalled).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'timeout' })
    });
  });
});

describe('reconnecting after a terminated worker', () => {
  function stubLocks(request: LockManager['request']) {
    vi.stubGlobal('navigator', { ...navigator, locks: { request } });
  }

  it('waits for the old worker to give up the vault lock', async () => {
    let release!: () => void;
    const request = vi.fn(
      () =>
        new Promise<void>((done) => {
          release = done;
        })
    );
    stubLocks(request as unknown as LockManager['request']);
    FakeWorker.plans = [{ notes: 'hang' }, {}];
    const vault = await loadVault();
    const run = outcome(
      vault.importBrowserNotes(
        { name: 'Vault', single: false, files: [] },
        {},
        () => {}
      )
    );
    await vi.waitFor(() =>
      expect(FakeWorker.instances[0]?.messages.at(-1)?.method).toBe(
        'notesImport'
      )
    );
    vault.cancelBrowserNotesImport();
    await run;

    const next = vault.invokeBrowser('list_notes', {});
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request.mock.calls[0]).toEqual([
      'mindstream:sqlite-vault:pool',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      expect.any(Function)
    ]);
    expect(FakeWorker.instances).toHaveLength(1);

    release();
    await expect(next).resolves.toEqual([]);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('opens anyway when another tab holds the lock, so it can say so', async () => {
    stubLocks((async () => {
      throw new DOMException('Too long', 'TimeoutError');
    }) as unknown as LockManager['request']);
    FakeWorker.plans = [{ invoke: 'hang' }, {}];
    const vault = await loadVault();
    const stalled = outcome(vault.invokeBrowser('list_notes', {}));
    await vi.waitFor(() =>
      expect(FakeWorker.instances[0]?.invokes()).toHaveLength(1)
    );
    FakeWorker.instances[0].onerror?.({ message: 'Worker failed' });
    await stalled;

    await expect(vault.invokeBrowser('list_notes', {})).resolves.toEqual([]);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('does not hide other lock failures', async () => {
    stubLocks((async () => {
      throw new DOMException('Denied', 'SecurityError');
    }) as unknown as LockManager['request']);
    FakeWorker.plans = [{ invoke: 'hang' }, {}];
    const vault = await loadVault();
    const stalled = outcome(vault.invokeBrowser('list_notes', {}));
    await vi.waitFor(() =>
      expect(FakeWorker.instances[0]?.invokes()).toHaveLength(1)
    );
    FakeWorker.instances[0].onerror?.({ message: 'Worker failed' });
    await stalled;

    await expect(vault.invokeBrowser('list_notes', {})).rejects.toMatchObject({
      name: 'SecurityError'
    });
    expect(FakeWorker.instances).toHaveLength(1);
  });
});

describe('notes import', () => {
  const source = {
    name: 'Vault',
    single: false,
    files: [{ path: 'a.md', file: new File(['a'], 'a.md') }]
  };

  it('asks the worker to detect and import the picked files', async () => {
    const vault = await loadVault();
    await vault.detectBrowserNotes(source);
    await vault.importBrowserNotes(source, { kind: 'gfm' }, () => {});
    expect(
      FakeWorker.instances[0].messages
        .filter((message) => message.method.startsWith('notes'))
        .map(({ method, args }) => ({ method, args }))
    ).toEqual([
      { method: 'notesDetect', args: { source } },
      { method: 'notesImport', args: { source, options: { kind: 'gfm' } } }
    ]);
  });

  it('cancels while the shared open is pending without sending an import', async () => {
    FakeWorker.plans = [{ open: 'hang' }];
    const vault = await loadVault();
    const progress = vi.fn();
    const run = outcome(vault.importBrowserNotes(source, {}, progress));

    await vi.waitFor(() =>
      expect(FakeWorker.instances[0]?.messages[0]?.method).toBe('open')
    );
    vault.cancelBrowserNotesImport();

    const worker = FakeWorker.instances[0];
    const open = worker.messages[0];
    worker.onmessage?.({
      data: { id: open.id, ok: true, result: undefined }
    });

    expect(await run).toEqual({ ok: false, error: { code: 'closed' } });
    expect(worker.messages.map(({ method }) => method)).toEqual(['open']);

    await expect(vault.importBrowserNotes(source, {}, () => {})).resolves.toBe(
      undefined
    );
    expect(worker.messages.map(({ method }) => method)).toEqual([
      'open',
      'notesImport'
    ]);
    expect(progress).not.toHaveBeenCalled();
  });

  it('passes progress on while the import runs, and only then', async () => {
    FakeWorker.plans = [{ notes: 'hang' }];
    const vault = await loadVault();
    const progress = vi.fn();
    const run = outcome(vault.importBrowserNotes(source, {}, progress));
    await vi.waitFor(() =>
      expect(
        FakeWorker.instances[0]?.messages.some(
          (message) => message.method === 'notesImport'
        )
      ).toBe(true)
    );

    const worker = FakeWorker.instances[0];
    const update = { phase: 'importing', done: 500, total: 900 };
    worker.onmessage?.({ data: { progress: update } });
    expect(progress).toHaveBeenCalledWith(update);

    const message = worker.messages.at(-1)!;
    worker.onmessage?.({ data: { id: message.id, ok: true, result: {} } });
    await run;
    worker.onmessage?.({ data: { progress: update } });
    expect(progress).toHaveBeenCalledOnce();
  });

  it('gives an import hours, then still catches a stalled worker', async () => {
    vi.useFakeTimers();
    FakeWorker.plans = [{ notes: 'hang' }];
    const vault = await loadVault();
    const stalled = outcome(vault.importBrowserNotes(source, {}, () => {}));
    await vi.advanceTimersByTimeAsync(5 * 60 * 60_000);
    expect(FakeWorker.instances[0].terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(await stalled).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'timeout' })
    });
  });

  it('stops a running import by terminating its worker, then reconnects', async () => {
    FakeWorker.plans = [{ notes: 'hang' }, {}];
    const vault = await loadVault();
    const run = outcome(vault.importBrowserNotes(source, {}, () => {}));
    await vi.waitFor(() =>
      expect(FakeWorker.instances[0]?.messages.at(-1)?.method).toBe(
        'notesImport'
      )
    );

    vault.cancelBrowserNotesImport();

    expect(await run).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'closed' })
    });
    expect(FakeWorker.instances[0].terminated).toBe(true);
    await expect(vault.invokeBrowser('list_notes', {})).resolves.toEqual([]);
    expect(FakeWorker.instances).toHaveLength(2);
  });
});

describe('test vault reset lifecycle', () => {
  function qa() {
    vi.stubEnv('MODE', 'development');
    vi.stubEnv('VITE_BROWSER_MOCKS', '0');
    vi.stubEnv('VITE_BROWSER_TEST_VAULT', 'qa');
  }
  it('closes the owner and blocks new operations until the requested reload', async () => {
    qa();
    const { invokeBrowser, prepareBrowserTestReset } = await loadVault();
    await invokeBrowser('list_notes', {});
    expect(FakeWorker.instances[0].messages[0].args).toEqual({
      scope: 'vault',
      testId: 'qa'
    });
    await prepareBrowserTestReset();
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(sessionStorage.getItem('mindstream:browser-test:qa:reset')).toBe(
      '1'
    );
    await expect(invokeBrowser('list_notes', {})).rejects.toMatchObject({
      code: 'closed'
    });
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('resets and seeds before reading, without replaying discarded drafts', async () => {
    qa();
    sessionStorage.setItem('mindstream:browser-test:qa:reset', '1');
    localStorage.setItem('mindstream:browser-test:qa:draft:v1:note', 'discard');
    localStorage.setItem(
      'mindstream:browser-test:qa:recovery:v1:note',
      'discard'
    );
    localStorage.setItem('mindstream:browser-vault:draft:v1:note', 'keep');
    const { invokeBrowser } = await loadVault();
    await invokeBrowser('list_notes', {});
    expect(FakeWorker.instances[0].messages.map((m) => m.method)).toEqual([
      'resetTestVault',
      'invoke'
    ]);
    expect(
      localStorage.getItem('mindstream:browser-test:qa:draft:v1:note')
    ).toBeNull();
    expect(
      localStorage.getItem('mindstream:browser-test:qa:recovery:v1:note')
    ).toBeNull();
    expect(localStorage.getItem('mindstream:browser-vault:draft:v1:note')).toBe(
      'keep'
    );
    expect(
      sessionStorage.getItem('mindstream:browser-test:qa:reset')
    ).toBeNull();
  });

  it('blocks loading after a refused reset without retrying or discarding recovery copies', async () => {
    qa();
    sessionStorage.setItem('mindstream:browser-test:qa:reset', '1');
    localStorage.setItem(
      'mindstream:browser-test:qa:draft:v1:note',
      'keep until reset succeeds'
    );
    FakeWorker.plans = [
      { reset: { error: { code: 'databaseBusy', message: 'Other tab' } } }
    ];
    const { invokeBrowser } = await loadVault();
    await expect(invokeBrowser('list_notes', {})).rejects.toMatchObject({
      code: 'databaseBusy'
    });
    expect(FakeWorker.instances[0].terminated).toBe(true);
    await expect(invokeBrowser('list_notes', {})).rejects.toMatchObject({
      message: expect.stringContaining('Notes have not been loaded')
    });
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].invokes()).toHaveLength(0);
    expect(
      localStorage.getItem('mindstream:browser-test:qa:draft:v1:note')
    ).not.toBeNull();
    expect(sessionStorage.getItem('mindstream:browser-test:qa:reset')).toBe(
      'failed'
    );
  });

  it('keeps a failed startup blocked across reloads until an explicit reset', async () => {
    qa();
    sessionStorage.setItem('mindstream:browser-test:qa:reset', '1');
    FakeWorker.plans = [
      {
        reset: { error: { code: 'io', message: 'Seed failed after deletion' } }
      }
    ];
    let vault = await loadVault();
    await expect(vault.invokeBrowser('list_notes')).rejects.toMatchObject({
      message: expect.stringContaining('Notes have not been loaded')
    });
    await expect(vault.invokeBrowser('list_notes')).rejects.toMatchObject({
      code: 'io'
    });
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].invokes()).toHaveLength(0);
    vault = await loadVault();
    await expect(vault.invokeBrowser('list_notes')).rejects.toMatchObject({
      message: expect.stringContaining('Reset test data')
    });
    expect(FakeWorker.instances).toHaveLength(1);
    await vault.prepareBrowserTestReset();
    vault = await loadVault();
    await expect(vault.invokeBrowser('list_notes')).resolves.toEqual([]);
    expect(FakeWorker.instances[1].messages.map((m) => m.method)).toEqual([
      'resetTestVault',
      'invoke'
    ]);
  });

  it('never picks up a reset marker introduced after notes have loaded', async () => {
    qa();
    const vault = await loadVault();
    await vault.invokeBrowser('list_notes');
    sessionStorage.setItem('mindstream:browser-test:qa:reset', '1');
    FakeWorker.instances[0].onerror?.({ message: 'worker crashed' });
    await vault.invokeBrowser('list_notes');
    expect(FakeWorker.instances[1].messages.map((m) => m.method)).toEqual([
      'open',
      'invoke'
    ]);
  });

  it('does not offer reset on normal or native storage', async () => {
    const { prepareBrowserTestReset } = await loadVault();
    await expect(prepareBrowserTestReset()).rejects.toThrow(/only/);
    expect(FakeWorker.instances).toHaveLength(0);
    qa();
    (
      window as unknown as { __TAURI_INTERNALS__?: unknown }
    ).__TAURI_INTERNALS__ = {};
    try {
      await expect(prepareBrowserTestReset()).rejects.toThrow(/only/);
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__;
    }
    expect(FakeWorker.instances).toHaveLength(0);
  });
});
