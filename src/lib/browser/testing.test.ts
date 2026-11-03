import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTestVaultId, vaultNamespace } from './namespace';
import { browserTestVaultId } from './testing';
import {
  checkpointBrowserNote,
  clearBrowserTestRecovery,
  rememberBrowserNote,
  recoverBrowserNotes
} from './recovery';
import type { BrowserStorageClient } from './client';

beforeEach(() => {
  vi.stubEnv('MODE', 'development');
  vi.stubEnv('VITE_BROWSER_MOCKS', '0');
  vi.stubEnv('VITE_BROWSER_TEST_VAULT', 'qa');
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  localStorage.clear();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
});

describe('isolated browser test vaults', () => {
  it('scopes directories, locks, journals, and reset markers with the same identifier', () => {
    const qa = vaultNamespace('qa');
    const other = vaultNamespace('other');
    const normal = vaultNamespace();
    for (const key of [
      'directory',
      'lock',
      'draft',
      'archive',
      'reset'
    ] as const) {
      expect(qa[key]).not.toBe(other[key]);
      expect(qa[key]).not.toBe(normal[key]);
    }
    expect(normal.directory).toBe('.mindstream-browser-vault');
    expect(normal.draft).toBe('mindstream:browser-vault:draft:v1:');
    expect(normal.reset).toBeUndefined();
    expect(browserTestVaultId()).toBe('qa');
  });

  it.each([
    '',
    '..',
    '../vault',
    '/vault',
    'QA',
    '-qa',
    'qa/a',
    'x'.repeat(49),
    undefined,
    7
  ])('rejects invalid identifiers: %s', (id) => {
    expect(isTestVaultId(id)).toBe(false);
    if (id !== undefined) expect(() => vaultNamespace(id as string)).toThrow();
  });

  it('fails closed on an invalid configured test vault', () => {
    vi.stubEnv('VITE_BROWSER_TEST_VAULT', '../vault');
    expect(browserTestVaultId).toThrow();
  });

  it('does not expose test mode to Tauri or mocked fixtures', () => {
    vi.stubEnv('VITE_BROWSER_MOCKS', '1');
    expect(browserTestVaultId()).toBeUndefined();
    vi.stubEnv('VITE_BROWSER_MOCKS', '0');
    (
      window as unknown as { __TAURI_INTERNALS__?: unknown }
    ).__TAURI_INTERNALS__ = {};
    expect(browserTestVaultId()).toBeUndefined();
  });

  it('resets only the selected test journal and retained copies', () => {
    const qa = vaultNamespace('qa');
    const other = vaultNamespace('other');
    const normal = vaultNamespace();
    for (const names of [qa, other, normal]) {
      localStorage.setItem(names.draft + 'note', 'draft');
      localStorage.setItem(names.archive + 'note', 'retained');
    }
    localStorage.setItem('theme', 'dark');
    expect(() => clearBrowserTestRecovery('other')).toThrow();
    clearBrowserTestRecovery('qa');
    expect(localStorage.getItem(qa.draft + 'note')).toBeNull();
    expect(localStorage.getItem(qa.archive + 'note')).toBeNull();
    for (const names of [other, normal]) {
      expect(localStorage.getItem(names.draft + 'note')).toBe('draft');
      expect(localStorage.getItem(names.archive + 'note')).toBe('retained');
    }
    expect(localStorage.getItem('theme')).toBe('dark');
    vi.stubEnv('VITE_BROWSER_TEST_VAULT', '');
    expect(() => clearBrowserTestRecovery('qa')).toThrow();
  });

  it('checkpoints and replays only its own recovery namespace', async () => {
    rememberBrowserNote({ id: 'note', body: 'original', yrs_state: [] });
    checkpointBrowserNote(() => ({ id: 'note', body: 'QA edit' }));
    const qa = vaultNamespace('qa');
    const normal = vaultNamespace();
    expect(localStorage.getItem(qa.draft + 'note')).not.toBeNull();
    localStorage.setItem(
      normal.draft + 'note',
      '{invalid normal draft must remain untouched'
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'note',
        body: 'original',
        yrs_state: [],
        trashed: false
      })
      .mockResolvedValueOnce({ id: 'note', body: 'QA edit', yrs_state: [] });
    await recoverBrowserNotes({ request } as unknown as Pick<
      BrowserStorageClient,
      'request'
    >);
    expect(request).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(qa.draft + 'note')).toBeNull();
    expect(localStorage.getItem(normal.draft + 'note')).toBe(
      '{invalid normal draft must remain untouched'
    );
  });
});
