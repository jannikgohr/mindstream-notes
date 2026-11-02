import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserStorageClient } from './client';
import { parseRequest, parseResult } from './protocol';

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  reply(data: unknown) {
    this.onmessage?.({ data });
  }
}

function setup(timeout = 30_000) {
  const worker = new FakeWorker();
  const client = new BrowserStorageClient(
    () => worker as unknown as Worker,
    timeout
  );
  return { client, worker };
}

afterEach(() => vi.useRealTimers());

describe('worker transport', () => {
  it('correlates concurrent responses even when they arrive out of order', async () => {
    const { client, worker } = setup();
    const first = client.request('read', undefined);
    const second = client.request('write', { body: 'text' });
    worker.reply({ id: 2, ok: true, result: undefined });
    worker.reply({ id: 1, ok: true, result: 'stored' });
    await expect(first).resolves.toBe('stored');
    await expect(second).resolves.toBeUndefined();
    client.dispose();
  });

  it('preserves a structured second-tab refusal', async () => {
    const { client, worker } = setup();
    const request = client.request('open', undefined);
    worker.reply({
      id: 1,
      ok: false,
      error: { code: 'databaseBusy', message: 'Already open' }
    });
    await expect(request).rejects.toEqual({
      code: 'databaseBusy',
      message: 'Already open'
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
    client.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('rejects every pending call and terminates on worker errors', async () => {
    const { client, worker } = setup();
    const results = Promise.allSettled([
      client.request('read', undefined),
      client.request('open', undefined)
    ]);
    worker.onerror?.({ message: 'Worker failed' });
    expect(await results).toEqual([
      {
        status: 'rejected',
        reason: { code: 'worker', message: 'Worker failed' }
      },
      {
        status: 'rejected',
        reason: { code: 'worker', message: 'Worker failed' }
      }
    ]);
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(client.request('open', undefined)).rejects.toMatchObject({
      code: 'closed'
    });
  });

  it('ignores messages it cannot match to a request', async () => {
    const { client, worker } = setup();
    const request = client.request('read', undefined);
    worker.reply(null);
    worker.reply('stored');
    worker.reply({ id: 2, ok: true, result: 'stored' });
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.reply({ id: 1, ok: true, result: 'stored' });
    await expect(request).resolves.toBe('stored');
    client.dispose();
  });

  it('still names a worker failure that came without a message', async () => {
    const { client, worker } = setup();
    const request = client.request('read', undefined);
    worker.onerror?.({ message: '' });
    await expect(request).rejects.toEqual({
      code: 'worker',
      message: 'Storage worker failed'
    });
  });

  it('closes when a response cannot be read', async () => {
    const { client, worker } = setup();
    const request = client.request('read', undefined);
    worker.onmessageerror?.();
    await expect(request).rejects.toEqual({
      code: 'worker',
      message: 'Storage worker returned an unreadable message'
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(client.isClosed).toBe(true);
  });

  it('fails the request and closes when the worker refuses the message', async () => {
    const { client, worker } = setup();
    worker.postMessage.mockImplementation(() => {
      throw new Error('could not be cloned');
    });
    await expect(client.request('read', undefined)).rejects.toEqual({
      code: 'worker',
      message: 'could not be cloned'
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('terminates a stalled worker so its pool lock can be released', async () => {
    vi.useFakeTimers();
    const { client, worker } = setup(100);
    const result = expect(
      client.request('read', undefined)
    ).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('gives a slow request its own deadline', async () => {
    vi.useFakeTimers();
    const { client, worker } = setup(100);
    const request = client.request('read', undefined, 1_000);
    await vi.advanceTimersByTimeAsync(500);
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.reply({ id: 1, ok: true, result: 'stored' });
    await expect(request).resolves.toBe('stored');
    client.dispose();
  });

  it('lets ordinary requests wait behind a slow one', async () => {
    vi.useFakeTimers();
    const { client, worker } = setup(100);
    const slow = client.request('read', undefined, 1_000);
    const queued = client.request('read', undefined);

    await vi.advanceTimersByTimeAsync(500);
    expect(worker.terminate).not.toHaveBeenCalled();

    worker.reply({ id: 1, ok: true, result: 'slow' });
    worker.reply({ id: 2, ok: true, result: 'queued' });
    await expect(slow).resolves.toBe('slow');
    await expect(queued).resolves.toBe('queued');
    client.dispose();
  });

  it('catches a stalled worker again once the slow request has ended', async () => {
    vi.useFakeTimers();
    const { client, worker } = setup(100);
    const slow = client.request('read', undefined, 1_000);
    worker.reply({ id: 1, ok: true, result: 'slow' });
    await slow;

    const stalled = expect(
      client.request('read', undefined)
    ).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(100);
    await stalled;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('still catches a worker that stalls with requests queued behind it', async () => {
    vi.useFakeTimers();
    const { client, worker } = setup(100);
    const slow = expect(
      client.request('read', undefined, 1_000)
    ).rejects.toMatchObject({ code: 'timeout' });
    const queued = expect(
      client.request('read', undefined)
    ).rejects.toMatchObject({ code: 'timeout' });

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([slow, queued]);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('terminates even if graceful shutdown fails', async () => {
    const { client, worker } = setup();
    const result = expect(client.close()).rejects.toMatchObject({
      code: 'database'
    });
    worker.reply({
      id: 1,
      ok: false,
      error: { code: 'database', message: 'Close failed' }
    });
    await result;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

describe('worker protocol validation', () => {
  it('accepts only named test vaults for open and reset', () => {
    expect(
      parseRequest({
        id: 1,
        method: 'open',
        args: { scope: 'vault', testId: 'qa' }
      })
    ).toMatchObject({ args: { testId: 'qa' } });
    expect(
      parseRequest({ id: 1, method: 'resetTestVault', args: { testId: 'qa' } })
    ).toMatchObject({ method: 'resetTestVault' });
    for (const testId of ['', '../vault', '/vault', 'QA', undefined]) {
      expect(() =>
        parseRequest({ id: 1, method: 'resetTestVault', args: { testId } })
      ).toThrow();
      if (testId !== undefined)
        expect(() =>
          parseRequest({
            id: 1,
            method: 'open',
            args: { scope: 'vault', testId }
          })
        ).toThrow();
    }
    expect(() =>
      parseRequest({ id: 1, method: 'resetTestVault', args: undefined })
    ).toThrow();
  });

  it('validates save receipt requests and responses', () => {
    expect(
      parseRequest({ id: 1, method: 'receipt', args: { id: 'note' } })
    ).toMatchObject({ method: 'receipt' });
    expect(() =>
      parseRequest({ id: 1, method: 'receipt', args: { id: 7 } })
    ).toThrow();
    expect(() =>
      parseRequest({
        id: 1,
        method: 'invoke',
        args: {
          command: 'save_note',
          args: { input: { id: 'note' } },
          recoveryToken: 7
        }
      })
    ).toThrow();
    expect(parseResult('receipt', 'write-token')).toBe('write-token');
    expect(parseResult('receipt', null)).toBeNull();
    expect(() => parseResult('receipt', {})).toThrow();
  });

  it('validates backup requests and responses', () => {
    expect(parseRequest({ id: 1, method: 'backup' })).toMatchObject({
      method: 'backup'
    });
    expect(() =>
      parseRequest({ id: 1, method: 'backup', args: { path: '/x' } })
    ).toThrow();
    const backup = {
      archive: new Blob(['zip']),
      filename: 'mindstream-backup.zip',
      counts: { notes: 1, folders: 0, assets_bytes: 2 },
      accountPresent: false
    };
    expect(parseResult('backup', backup)).toBe(backup);
    for (const broken of [
      null,
      { ...backup, archive: 'zip' },
      { ...backup, filename: 7 },
      { ...backup, accountPresent: 'no' },
      { ...backup, counts: { ...backup.counts, notes: -0.5 } },
      { ...backup, counts: undefined }
    ]) {
      expect(() => parseResult('backup', broken)).toThrow();
    }
  });

  it('validates backup import requests and responses', () => {
    const archive = new Blob(['zip']);
    expect(
      parseRequest({ id: 1, method: 'importBegin', args: { archive } })
    ).toMatchObject({ method: 'importBegin' });
    expect(
      parseRequest({
        id: 1,
        method: 'importRestore',
        args: { token: 't', sameAccount: false }
      })
    ).toMatchObject({ method: 'importRestore' });
    for (const method of ['importMerge', 'importCleanup']) {
      expect(
        parseRequest({ id: 1, method, args: { token: 't' } })
      ).toMatchObject({ method });
    }
    for (const invalid of [
      { method: 'importBegin', args: { archive: 'zip' } },
      { method: 'importBegin' },
      { method: 'importMerge', args: { token: '' } },
      { method: 'importCleanup', args: {} },
      { method: 'importRestore', args: { token: 't' } },
      { method: 'importRestore', args: { token: 't', sameAccount: 'no' } }
    ]) {
      expect(() => parseRequest({ id: 1, ...invalid })).toThrow();
    }
    expect(parseResult('importRestore', true)).toBe(true);
    expect(() => parseResult('importRestore', 'done')).toThrow();
  });

  it('rejects unrecognized methods and invalid write payloads', () => {
    expect(() =>
      parseRequest({ id: 1, method: 'execute_sql', args: 'DROP TABLE notes' })
    ).toThrow();
    expect(() => parseRequest({ id: 0, method: 'read' })).toThrow();
    expect(() =>
      parseRequest({ id: 1, method: 'write', args: { body: 1 } })
    ).toThrow();
    expect(() => parseRequest({ id: 1, method: 'read', args: {} })).toThrow();
  });

  it('checks responses before callers can use them', () => {
    expect(() => parseResult('verify', { schemaVersion: 34 })).toThrow();
    expect(() => parseResult('read', {})).toThrow();
    expect(() => parseResult('write', 'saved')).toThrow();
    expect(parseResult('read', null)).toBeNull();
  });
});
