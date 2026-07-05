import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INFO_VALUES,
  SETTING_ACTIONS,
  SETTING_BINDINGS
} from './registry.svelte';
import {
  getCustomWindowDecorations,
  setCustomWindowDecorations
} from '$lib/api/desktop-settings';
import { isTauri } from '$lib/api/core';

vi.mock('$lib/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/api/core')>()),
  isTauri: vi.fn()
}));

vi.mock('$lib/api/desktop-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/api/desktop-settings')>()),
  getCustomWindowDecorations: vi.fn(),
  setCustomWindowDecorations: vi.fn()
}));

// Outside Tauri (the test environment), the desktop-only bindings take
// their no-op / false branches, so every get/set is safe to invoke.

const mockedIsTauri = vi.mocked(isTauri);
const mockedGetCustomWindowDecorations = vi.mocked(getCustomWindowDecorations);
const mockedSetCustomWindowDecorations = vi.mocked(setCustomWindowDecorations);

beforeEach(() => {
  localStorage.clear();
  mockedIsTauri.mockReset().mockReturnValue(false);
  mockedGetCustomWindowDecorations.mockReset().mockResolvedValue(true);
  mockedSetCustomWindowDecorations.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    configurable: true
  });
});
afterEach(() => localStorage.clear());

describe('SETTING_BINDINGS — desktop-gated entries are inert off-Tauri', () => {
  it('startOnLogin reports false and set is a no-op', async () => {
    expect(await SETTING_BINDINGS['general.startOnLogin'].get()).toBe(false);
    await expect(
      SETTING_BINDINGS['general.startOnLogin'].set(true)
    ).resolves.toBeUndefined();
  });

  it('closeToTray / startInTray report false off-Tauri', async () => {
    expect(await SETTING_BINDINGS['general.closeToTray'].get()).toBe(false);
    expect(await SETTING_BINDINGS['general.startInTray'].get()).toBe(false);
    await SETTING_BINDINGS['general.closeToTray'].set(true);
    await SETTING_BINDINGS['general.startInTray'].set(true);
  });
});

describe('SETTING_BINDINGS — appearance', () => {
  it('mode defaults to system and round-trips through localStorage', async () => {
    expect(await SETTING_BINDINGS['appearance.mode'].get()).toBe('system');
    await SETTING_BINDINGS['appearance.mode'].set('dark');
    expect(localStorage.getItem('mode-watcher-mode')).toBe('dark');
  });

  it('sortStrategy reads and writes app ui state', async () => {
    await SETTING_BINDINGS['appearance.sortStrategy'].set('alphabetical');
    expect(await SETTING_BINDINGS['appearance.sortStrategy'].get()).toBe(
      'alphabetical'
    );
  });

  it('sidebar width bindings coerce to numbers', async () => {
    await SETTING_BINDINGS['appearance.leftSidebarWidth'].set('320');
    expect(await SETTING_BINDINGS['appearance.leftSidebarWidth'].get()).toBe(
      320
    );
    await SETTING_BINDINGS['appearance.rightSidebarWidth'].set('280');
    expect(await SETTING_BINDINGS['appearance.rightSidebarWidth'].get()).toBe(
      280
    );
  });

  it('custom window decorations default to native chrome off-Tauri on macOS', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true
    });

    expect(
      await SETTING_BINDINGS['appearance.customWindowDecorations'].get()
    ).toBe(false);
    await SETTING_BINDINGS['appearance.customWindowDecorations'].set(true);
    expect(mockedSetCustomWindowDecorations).not.toHaveBeenCalled();
  });

  it('custom window decorations default to custom chrome off-Tauri on other platforms', async () => {
    expect(
      await SETTING_BINDINGS['appearance.customWindowDecorations'].get()
    ).toBe(true);
  });

  it('custom window decorations round-trip through desktop settings in Tauri', async () => {
    mockedIsTauri.mockReturnValue(true);
    mockedGetCustomWindowDecorations.mockResolvedValue(false);

    expect(
      await SETTING_BINDINGS['appearance.customWindowDecorations'].get()
    ).toBe(false);

    await SETTING_BINDINGS['appearance.customWindowDecorations'].set(true);
    await SETTING_BINDINGS['appearance.customWindowDecorations'].set(false);

    expect(mockedSetCustomWindowDecorations).toHaveBeenNthCalledWith(1, true);
    expect(mockedSetCustomWindowDecorations).toHaveBeenNthCalledWith(2, false);
  });
});

describe('SETTING_BINDINGS — language', () => {
  it('get defaults to en and persists to localStorage', async () => {
    const code = await SETTING_BINDINGS['language.code'].get();
    expect(code).toBe('en');
    expect(localStorage.getItem('notes-app:language')).toBe('en');
  });

  it('set stores the chosen code', async () => {
    await SETTING_BINDINGS['language.code'].set('de');
    expect(localStorage.getItem('notes-app:language')).toBe('de');
  });
});

describe('INFO_VALUES', () => {
  it('appVersion returns the package version', () => {
    expect(INFO_VALUES['about.appVersion']()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('tauriVersion lists cleaned dependency versions', () => {
    const text = INFO_VALUES['about.tauriVersion']();
    expect(text).toContain('Tauri ');
    expect(text).toContain('Svelte ');
    // Caret/tilde range markers are stripped.
    expect(text).not.toMatch(/[\^~]/);
  });

  it('managedUnavailable resolves a translation key', () => {
    expect(typeof INFO_VALUES['account.managedUnavailable']()).toBe('string');
  });
});

describe('SETTING_ACTIONS', () => {
  it('exposes a handler for every data + update action id', () => {
    for (const id of [
      'open-data-folder',
      'empty-trash',
      'backup-now',
      'restore-backup',
      'export-vault',
      'import-notes',
      'check-updates'
    ]) {
      expect(typeof SETTING_ACTIONS[id]).toBe('function');
    }
  });
});
