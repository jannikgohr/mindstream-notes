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
