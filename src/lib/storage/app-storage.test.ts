import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readAppStorage,
  removeAppStorage,
  writeAppStorage
} from './app-storage';
import {
  markVaultLost,
  markVaultReady,
  markVaultUnavailable,
  registerVaultAccessProbe,
  resetVaultAccessForTests
} from './vault-access.svelte';

beforeEach(() => {
  localStorage.clear();
  resetVaultAccessForTests('pending');
  // Loading is driven by the test, through markVaultReady/Unavailable.
  registerVaultAccessProbe(async () => {});
});
afterEach(() => registerVaultAccessProbe(null));

describe('app storage', () => {
  it('writes at once when the vault is ready', () => {
    markVaultReady();
    writeAppStorage('k', 'v');
    expect(localStorage.getItem('k')).toBe('v');
    removeAppStorage('k');
    expect(localStorage.getItem('k')).toBeNull();
  });

  it('holds writes until the vault is ready, and reads the held value back', () => {
    localStorage.setItem('gone', 'old');
    writeAppStorage('k', 'first');
    writeAppStorage('k', 'second');
    removeAppStorage('gone');
    expect(localStorage.getItem('k')).toBeNull();
    expect(readAppStorage('k')).toBe('second');
    expect(readAppStorage('gone')).toBeNull();
    markVaultReady();
    expect(localStorage.getItem('k')).toBe('second');
    expect(localStorage.getItem('gone')).toBeNull();
  });

  it('drops held and new writes when the vault is unavailable', () => {
    localStorage.setItem('k', 'owner');
    writeAppStorage('k', 'stale snapshot');
    markVaultUnavailable('The database is open in another tab.');
    writeAppStorage('k', 'later change');
    removeAppStorage('k');
    expect(localStorage.getItem('k')).toBe('owner');
    expect(readAppStorage('k')).toBe('owner');
    // Nothing held survives into a later successful load.
    markVaultReady();
    expect(localStorage.getItem('k')).toBe('owner');
  });

  it('drops writes held while the vault reconnects after a lost worker', () => {
    markVaultReady();
    writeAppStorage('k', 'before');
    markVaultLost();
    // Another tab owned the vault meanwhile and saved its own value.
    localStorage.setItem('k', 'other tab');
    writeAppStorage('k', 'stale snapshot');
    markVaultReady();
    expect(localStorage.getItem('k')).toBe('other tab');
    writeAppStorage('k', 'after');
    expect(localStorage.getItem('k')).toBe('after');
  });
});
