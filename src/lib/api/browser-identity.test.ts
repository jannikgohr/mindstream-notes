import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkerBrowserOptions } from './browser-identity';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

beforeEach(() => {
  invoke.mockReset();
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {}
  });
});
afterEach(() => Reflect.deleteProperty(window, '__TAURI_INTERNALS__'));

describe('worker browser options', () => {
  it('uses the worker directory or persistent macOS identifier and preserves direct-test fallback', async () => {
    invoke.mockResolvedValueOnce({
      dataDirectory: 'C:/disposable/vault-browser',
      dataStoreIdentifier: null,
      additionalBrowserArgs: '--renderer-process-limit=1'
    });
    expect(await getWorkerBrowserOptions()).toEqual({
      dataDirectory: 'C:/disposable/vault-browser',
      additionalBrowserArgs: '--renderer-process-limit=1'
    });
    const id = Array.from({ length: 16 }, (_, i) => i);
    invoke.mockResolvedValueOnce({
      dataDirectory: null,
      dataStoreIdentifier: id
    });
    expect(await getWorkerBrowserOptions()).toEqual({
      dataStoreIdentifier: id
    });
    invoke.mockResolvedValueOnce(null);
    expect(await getWorkerBrowserOptions()).toEqual({});
    invoke.mockResolvedValueOnce({
      dataDirectory: null,
      dataStoreIdentifier: null,
      additionalBrowserArgs: '--renderer-process-limit=1'
    });
    expect(await getWorkerBrowserOptions()).toEqual({
      additionalBrowserArgs: '--renderer-process-limit=1'
    });
    expect(invoke).toHaveBeenCalledWith(
      'get_worker_browser_options',
      undefined
    );
  });
  it('refuses invalid persistent identities instead of falling back to shared storage', async () => {
    for (const id of [[1], Array(16).fill(256), Array(16).fill(1.5), null]) {
      invoke.mockResolvedValueOnce({
        dataDirectory: null,
        dataStoreIdentifier: id
      });
      await expect(getWorkerBrowserOptions()).rejects.toThrow();
    }
  });
});
