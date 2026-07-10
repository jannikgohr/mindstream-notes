import { beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_SETTINGS,
  BY_ID,
  closeSettings,
  defaultForSetting,
  getSettingValue,
  hasSettingValue,
  isCategoryVisible,
  isModified,
  isPending,
  isSectionVisible,
  isVisible,
  openSettings,
  resetSettingValue,
  setSettingValue,
  setSettingsVaultId,
  settings,
  settingsDialog
} from './store.svelte';
import type { Setting } from './types';

const setting = (over: Partial<Setting> = {}): Setting =>
  ({
    id: 'test.setting',
    scope: 'V',
    type: 'toggle',
    default: false,
    ...over
  }) as Setting;

beforeEach(() => {
  // Pin a desktop UA so platform-filtered visibility is deterministic
  // (the default happy-dom UA is unrecognised → "show everything").
  Object.defineProperty(window.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    configurable: true
  });
  for (const key of Object.keys(settings.values)) delete settings.values[key];
  localStorage.clear();
  setSettingsVaultId('default');
  for (const key of Object.keys(settings.values)) delete settings.values[key];
  settings.pending.clear();
});

describe('schema flattening', () => {
  it('flattens all settings and indexes them by id', () => {
    expect(ALL_SETTINGS.length).toBeGreaterThan(0);
    for (const s of ALL_SETTINGS) {
      expect(BY_ID[s.id]).toBe(s);
    }
  });

  it('uses only vault and device scopes', () => {
    for (const s of ALL_SETTINGS) {
      expect(['V', 'D']).toContain(s.scope);
    }
  });

  it('keeps account settings vault-scoped', () => {
    expect(BY_ID['account.serverType'].scope).toBe('V');
    expect(BY_ID['account.signInForm'].scope).toBe('V');
    expect(BY_ID['account.syncEnabled'].scope).toBe('V');
    expect(BY_ID['account.syncInterval'].scope).toBe('V');
  });
});

describe('getSettingValue / hasSettingValue', () => {
  it('returns the cached value when present', () => {
    settings.values['x'] = 42;
    expect(getSettingValue('x')).toBe(42);
    expect(hasSettingValue('x')).toBe(true);
  });

  it('falls back to the schema default when uncached', () => {
    const first = ALL_SETTINGS.find((s) => 'default' in s)!;
    expect(getSettingValue(first.id)).toEqual(first.default);
    expect(hasSettingValue(first.id)).toBe(false);
  });

  it('uses platform-specific defaults when the current platform matches', () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true
    });

    expect(getSettingValue('appearance.customWindowDecorations')).toBe(false);
    expect(hasSettingValue('appearance.customWindowDecorations')).toBe(false);
  });

  it('falls back to the base default when no platform-specific default matches', () => {
    expect(getSettingValue('appearance.customWindowDecorations')).toBe(true);
  });

  it('supports grouped desktop platform defaults', () => {
    expect(
      defaultForSetting(
        setting({
          default: 'fallback',
          defaultByPlatform: { desktop: 'desktop-default' }
        })
      )
    ).toBe('desktop-default');
  });

  it('supports grouped mobile platform defaults', () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Linux; Android 16; Pixel)',
      configurable: true
    });

    expect(
      defaultForSetting(
        setting({
          default: 'fallback',
          defaultByPlatform: { mobile: 'mobile-default' }
        })
      )
    ).toBe('mobile-default');
  });

  it('ignores platform defaults when the current platform is unknown', () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'UnknownOS/1.0',
      configurable: true
    });

    expect(
      defaultForSetting(
        setting({
          default: 'fallback',
          defaultByPlatform: { desktop: 'desktop-default' }
        })
      )
    ).toBe('fallback');
  });
});

describe('setSettingValue / resetSettingValue', () => {
  it('writes a non-binding value into the cache', async () => {
    await setSettingValue('custom.key', 'hello');
    expect(getSettingValue('custom.key')).toBe('hello');
  });

  it('resets a known setting back to its default', async () => {
    const def = ALL_SETTINGS.find((s) => 'default' in s)!;
    await setSettingValue(def.id, 'changed');
    await resetSettingValue(def.id);
    expect(getSettingValue(def.id)).toEqual(def.default);
  });

  it('resets platform-defaulted settings back to the current platform default', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true
    });

    // This assertion is about resetSettingValue's platform-default logic, not
    // the binding write path. setSettingValue() re-reads the off-Tauri binding,
    // which canonicalizes macOS back to false immediately.
    settings.values['appearance.customWindowDecorations'] = true;
    expect(getSettingValue('appearance.customWindowDecorations')).toBe(true);

    await resetSettingValue('appearance.customWindowDecorations');
    expect(getSettingValue('appearance.customWindowDecorations')).toBe(false);
  });

  it('keeps vault-scoped account settings separate per vault', async () => {
    await setSettingValue('account.serverType', 'self-hosted');
    await setSettingValue('account.serverUrl', 'https://one.example');

    setSettingsVaultId('work');
    expect(getSettingValue('account.serverType')).toBe('local-only');
    expect(getSettingValue('account.serverUrl')).toBeUndefined();

    await setSettingValue('account.serverType', 'managed');

    setSettingsVaultId('default');
    expect(getSettingValue('account.serverType')).toBe('self-hosted');
    expect(getSettingValue('account.serverUrl')).toBe('https://one.example');

    setSettingsVaultId('work');
    expect(getSettingValue('account.serverType')).toBe('managed');
    expect(getSettingValue('account.serverUrl')).toBeUndefined();
  });

  it('keeps device-scoped settings shared across vaults', async () => {
    await setSettingValue('appearance.reduceMotion', 'on');

    setSettingsVaultId('work');
    expect(getSettingValue('appearance.reduceMotion')).toBe('on');

    await setSettingValue('custom.deviceKey', 'shared');
    setSettingsVaultId('default');
    expect(getSettingValue('custom.deviceKey')).toBe('shared');
  });
});

describe('isModified', () => {
  it('is false at the default and true once changed', () => {
    const def = ALL_SETTINGS.find(
      (s) => 'default' in s && typeof s.default !== 'object'
    )!;
    expect(isModified(def.id)).toBe(false);
    settings.values[def.id] = `${def.default}-changed`;
    expect(isModified(def.id)).toBe(true);
  });

  it('is false for an unknown id', () => {
    expect(isModified('nope.nope')).toBe(false);
  });

  it('compares against platform-specific defaults', () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true
    });

    expect(isModified('appearance.customWindowDecorations')).toBe(false);
    settings.values['appearance.customWindowDecorations'] = true;
    expect(isModified('appearance.customWindowDecorations')).toBe(true);
  });
});

describe('isPending', () => {
  it('reflects the pending set', () => {
    expect(isPending('x')).toBe(false);
    settings.pending.add('x');
    expect(isPending('x')).toBe(true);
  });
});

describe('isVisible', () => {
  it('is true with no showIf and no platform filter', () => {
    expect(isVisible(setting())).toBe(true);
  });

  it('honours an equals condition', () => {
    settings.values['dep'] = 'on';
    expect(isVisible(setting({ showIf: { id: 'dep', equals: 'on' } }))).toBe(
      true
    );
    expect(isVisible(setting({ showIf: { id: 'dep', equals: 'off' } }))).toBe(
      false
    );
  });

  it('honours a notEquals condition', () => {
    settings.values['dep'] = 'on';
    expect(
      isVisible(setting({ showIf: { id: 'dep', notEquals: 'off' } }))
    ).toBe(true);
    expect(isVisible(setting({ showIf: { id: 'dep', notEquals: 'on' } }))).toBe(
      false
    );
  });

  it('honours an in condition', () => {
    settings.values['dep'] = 'b';
    expect(isVisible(setting({ showIf: { id: 'dep', in: ['a', 'b'] } }))).toBe(
      true
    );
    expect(isVisible(setting({ showIf: { id: 'dep', in: ['a', 'c'] } }))).toBe(
      false
    );
  });

  it('hides settings filtered out by platform', () => {
    // The test UA is desktop, so a mobile-only setting is hidden.
    expect(isVisible(setting({ platforms: ['mobile'] }))).toBe(false);
  });
});

describe('section / category visibility', () => {
  it('matches by platform filter', () => {
    expect(isSectionVisible({ id: 's', settings: [] })).toBe(true);
    expect(isCategoryVisible({ id: 'c', sections: [] })).toBe(true);
    expect(
      isSectionVisible({ id: 's', platforms: ['mobile'], settings: [] })
    ).toBe(false);
  });
});

describe('dialog open/close', () => {
  it('toggles the dialog open state', () => {
    closeSettings();
    expect(settingsDialog.open).toBe(false);
    openSettings();
    expect(settingsDialog.open).toBe(true);
    closeSettings();
    expect(settingsDialog.open).toBe(false);
  });
});
