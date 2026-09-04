import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tauri: true,
  all: vi.fn(async () => ({}) as Record<string, unknown>),
  set: vi.fn(async () => {}),
  remove: vi.fn(async () => {})
}));

vi.mock('$lib/api/core', () => ({ isTauri: () => h.tauri }));
vi.mock('$lib/api/plugins', () => ({
  pluginsSettingsAll: h.all,
  pluginsSettingsSet: h.set,
  pluginsSettingsRemove: h.remove
}));

import {
  hasPluginSettingValue,
  hydratePluginSettings,
  parsePluginSettingId,
  pluginSettingId,
  pluginSettingValue,
  resetPluginSettingValue,
  resetPluginSettingsCache,
  setPluginSettingValue
} from './settings-store.svelte';

beforeEach(() => {
  h.tauri = true;
  h.all.mockReset().mockResolvedValue({});
  h.set.mockReset().mockResolvedValue(undefined);
  h.remove.mockReset().mockResolvedValue(undefined);
});
afterEach(() => resetPluginSettingsCache());

describe('parsePluginSettingId', () => {
  it('splits a dotted plugin id from its setting id', () => {
    // The plugin id is itself dotted, so this cannot be a three-way split —
    // that would break on every real plugin id.
    expect(
      parsePluginSettingId('plugins.com.mindstream.typst.default-view')
    ).toEqual({
      pluginId: 'com.mindstream.typst',
      settingId: 'default-view'
    });
  });

  it('rejects anything that is not a plugin setting id', () => {
    for (const id of [
      'editor.fontSize',
      'plugins',
      'plugins.',
      'plugins.only'
    ]) {
      expect(parsePluginSettingId(id)).toBeNull();
    }
  });

  it('round-trips with pluginSettingId', () => {
    const id = pluginSettingId('com.a.plugin', 'source-folder');
    expect(parsePluginSettingId(id)).toEqual({
      pluginId: 'com.a.plugin',
      settingId: 'source-folder'
    });
  });
});

describe('hydratePluginSettings', () => {
  it('loads stored values so the first synchronous read is real', async () => {
    h.all.mockResolvedValue({ 'source-folder': 'f1', 'open-on-create': true });
    await hydratePluginSettings('com.a.plugin');

    expect(pluginSettingValue('plugins.com.a.plugin.source-folder')).toBe('f1');
    expect(pluginSettingValue('plugins.com.a.plugin.open-on-create')).toBe(
      true
    );
    expect(hasPluginSettingValue('plugins.com.a.plugin.source-folder')).toBe(
      true
    );
  });

  it('survives a backend that fails, leaving defaults in play', async () => {
    h.all.mockRejectedValue(new Error('no vault'));
    await expect(
      hydratePluginSettings('com.a.plugin')
    ).resolves.toBeUndefined();
    expect(hasPluginSettingValue('plugins.com.a.plugin.x')).toBe(false);
  });
});

describe('setPluginSettingValue', () => {
  it('persists through the backend with the id split apart', async () => {
    await setPluginSettingValue('plugins.com.a.plugin.source-folder', 'f2');
    expect(h.set).toHaveBeenCalledWith('com.a.plugin', 'source-folder', 'f2');
    expect(pluginSettingValue('plugins.com.a.plugin.source-folder')).toBe('f2');
  });

  it('rolls the cache back when the write fails', async () => {
    // The control moves optimistically, so a failed write has to undo it —
    // otherwise the dialog shows a value that was never stored.
    h.all.mockResolvedValue({ 'source-folder': 'original' });
    await hydratePluginSettings('com.a.plugin');
    h.set.mockRejectedValue(new Error('disk full'));

    await expect(
      setPluginSettingValue('plugins.com.a.plugin.source-folder', 'new')
    ).rejects.toThrow('disk full');
    expect(pluginSettingValue('plugins.com.a.plugin.source-folder')).toBe(
      'original'
    );
  });

  it('drops the key again when a failed write had nothing to restore', async () => {
    h.set.mockRejectedValue(new Error('nope'));
    await expect(
      setPluginSettingValue('plugins.com.a.plugin.fresh', 1)
    ).rejects.toThrow();
    expect(hasPluginSettingValue('plugins.com.a.plugin.fresh')).toBe(false);
  });

  it('refuses an id that is not a plugin setting', async () => {
    await expect(setPluginSettingValue('editor.fontSize', 12)).rejects.toThrow(
      /not a plugin setting id/
    );
  });

  it('keeps the value in memory outside Tauri, where nothing persists', async () => {
    h.tauri = false;
    await setPluginSettingValue('plugins.com.a.plugin.k', 'v');
    expect(pluginSettingValue('plugins.com.a.plugin.k')).toBe('v');
    expect(h.set).not.toHaveBeenCalled();
  });
});

describe('resetPluginSettingValue', () => {
  it('clears the value so it falls back to the manifest default', async () => {
    h.all.mockResolvedValue({ k: 'stored' });
    await hydratePluginSettings('com.a.plugin');

    await resetPluginSettingValue('plugins.com.a.plugin.k');
    expect(hasPluginSettingValue('plugins.com.a.plugin.k')).toBe(false);
    expect(h.remove).toHaveBeenCalledWith('com.a.plugin', 'k');
  });

  it('restores the value when the backend refuses', async () => {
    h.all.mockResolvedValue({ k: 'stored' });
    await hydratePluginSettings('com.a.plugin');
    h.remove.mockRejectedValue(new Error('locked'));

    await expect(
      resetPluginSettingValue('plugins.com.a.plugin.k')
    ).rejects.toThrow('locked');
    expect(pluginSettingValue('plugins.com.a.plugin.k')).toBe('stored');
  });
});
