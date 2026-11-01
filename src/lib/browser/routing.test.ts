import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { nativeInvoke, browserInvoke } = vi.hoisted(() => ({
  nativeInvoke: vi.fn(),
  browserInvoke: vi.fn()
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeInvoke }));
vi.mock('./vault', () => ({ invokeBrowser: browserInvoke }));
import { invokeOrFallback, TauriCommandName } from '../api/core';

afterEach(() => {
  vi.unstubAllEnvs();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MODE', 'development');
  vi.stubEnv('VITE_BROWSER_MOCKS', '');
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('persistent browser API routing', () => {
  it('awaits worker operations and applies the existing response validator', async () => {
    const fallback = vi.fn();
    const validate = vi.fn(
      (value: unknown) => (value as { title: string }).title
    );
    browserInvoke.mockResolvedValueOnce({ title: 'Committed' });
    await expect(
      invokeOrFallback(
        TauriCommandName.SaveNote,
        { input: { id: 'note', body: 'text' } },
        fallback,
        validate
      )
    ).resolves.toBe('Committed');
    expect(browserInvoke).toHaveBeenCalledWith('save_note', {
      input: { id: 'note', body: 'text' }
    });
    expect(validate).toHaveBeenCalledWith({ title: 'Committed' });
    expect(fallback).not.toHaveBeenCalled();
    expect(nativeInvoke).not.toHaveBeenCalled();
  });

  it('rejects a failed persistent save without reporting a mock success', async () => {
    const error = { code: 'database', message: 'Storage is full' };
    browserInvoke.mockRejectedValueOnce(error);
    const fallback = vi.fn(() => ({ id: 'temporary' }));
    await expect(
      invokeOrFallback(
        TauriCommandName.CreateNote,
        { input: { title: 'Important' } },
        fallback,
        (value) => value
      )
    ).rejects.toBe(error);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('keeps native note operations on Tauri IPC', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    nativeInvoke.mockResolvedValueOnce('native result');
    await expect(
      invokeOrFallback(
        TauriCommandName.LoadNote,
        { id: 'native' },
        vi.fn(),
        (value) => value
      )
    ).resolves.toBe('native result');
    expect(nativeInvoke).toHaveBeenCalledWith('load_note', { id: 'native' });
    expect(browserInvoke).not.toHaveBeenCalled();
  });

  it('permits the disposable UI fixtures only when explicitly configured', async () => {
    vi.stubEnv('VITE_BROWSER_MOCKS', '1');
    await expect(
      invokeOrFallback(
        TauriCommandName.ListNotes,
        {},
        () => [],
        (value) => value
      )
    ).resolves.toEqual([]);
    expect(browserInvoke).not.toHaveBeenCalled();
  });
});
