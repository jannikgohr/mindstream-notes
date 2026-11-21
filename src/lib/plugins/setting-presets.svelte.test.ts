import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getSettingValue,
  resetSettingValue,
  setSettingValue
} from '$lib/settings/store.svelte';
import { registerPlugin, resetPluginRegistry } from './registry.svelte';
import {
  applyPreset,
  deletePreset,
  presetChanged,
  renamePreset,
  resetSettings,
  savePreset,
  selectedPreset,
  settingPresets
} from './setting-presets';
import {
  installPluginSettingsBridge,
  pluginSettingsSectionsFor,
  uninstallPluginSettingsBridge
} from './settings-bridge';

const PLUGIN = 'com.example.graph';
const id = (setting: string) => `plugins.${PLUGIN}.${setting}`;

beforeEach(() => {
  registerPlugin({
    manifestVersion: 2,
    id: PLUGIN,
    name: 'Example',
    version: '1.0.0',
    runtime: 'manifest-only',
    permissions: [],
    contributes: {
      i18n: { en: { title: 'Graph', depth: 'Depth', tags: 'Tags' } },
      settings: [
        {
          sectionId: 'graph',
          titleKey: 'title',
          settings: [
            {
              id: 'depth',
              labelKey: 'depth',
              scope: 'V',
              type: 'slider',
              default: 1,
              min: 1,
              max: 5,
              step: 1
            },
            {
              id: 'tags',
              labelKey: 'tags',
              scope: 'V',
              type: 'toggle',
              default: true
            }
          ]
        }
      ]
    }
  });
  installPluginSettingsBridge();
});
afterEach(async () => {
  await resetSettings(PLUGIN);
  await resetSettingValue(id('$presets'));
  await resetSettingValue(id('$preset'));
  uninstallPluginSettingsBridge();
  resetPluginRegistry();
});

describe('setting presets', () => {
  it('gives a slider the range its manifest declares', () => {
    expect(pluginSettingsSectionsFor(PLUGIN)[0].settings[0]).toMatchObject({
      min: 1,
      max: 5,
      step: 1
    });
  });

  it('saves the settings under a name and brings them back', async () => {
    await setSettingValue(id('depth'), 3);
    await setSettingValue(id('tags'), false);
    await savePreset(PLUGIN, 'Deep');
    expect(selectedPreset(PLUGIN)).toBe('Deep');
    expect(presetChanged(PLUGIN)).toBe(false);

    // A changed setting leaves the preset in use, marked as changed.
    await setSettingValue(id('depth'), 2);
    expect(selectedPreset(PLUGIN)).toBe('Deep');
    expect(presetChanged(PLUGIN)).toBe(true);
    await resetSettings(PLUGIN);
    expect(selectedPreset(PLUGIN)).toBeUndefined();
    expect(getSettingValue(id('depth'))).toBe(1);
    expect(getSettingValue(id('tags'))).toBe(true);

    await applyPreset(PLUGIN, 'Deep');
    expect(getSettingValue(id('depth'))).toBe(3);
    expect(getSettingValue(id('tags'))).toBe(false);
  });

  it('replaces a preset saved again under its name, and deletes one', async () => {
    await savePreset(PLUGIN, 'Mine');
    await setSettingValue(id('depth'), 4);
    await savePreset(PLUGIN, 'Mine');
    expect(settingPresets(PLUGIN)).toEqual([
      { name: 'Mine', values: { depth: 4, tags: true } }
    ]);

    await deletePreset(PLUGIN, 'Mine');
    expect(settingPresets(PLUGIN)).toEqual([]);
    // Deleting a preset leaves the settings as they are.
    expect(getSettingValue(id('depth'))).toBe(4);
  });

  it('updates the preset in use in place, and renames it', async () => {
    await savePreset(PLUGIN, 'First');
    await setSettingValue(id('depth'), 5);
    await savePreset(PLUGIN, 'Second');
    await applyPreset(PLUGIN, 'First');
    await setSettingValue(id('tags'), false);
    await savePreset(PLUGIN, 'First');
    expect(settingPresets(PLUGIN)).toEqual([
      { name: 'First', values: { depth: 1, tags: false } },
      { name: 'Second', values: { depth: 5, tags: true } }
    ]);
    expect(presetChanged(PLUGIN)).toBe(false);

    await renamePreset(PLUGIN, 'First', 'Flat');
    expect(settingPresets(PLUGIN).map((preset) => preset.name)).toEqual([
      'Flat',
      'Second'
    ]);
    expect(selectedPreset(PLUGIN)).toBe('Flat');
    // A name that is taken goes to the renamed preset.
    await renamePreset(PLUGIN, 'Flat', 'Second');
    expect(settingPresets(PLUGIN)).toEqual([
      { name: 'Second', values: { depth: 1, tags: false } }
    ]);

    await deletePreset(PLUGIN, 'Second');
    expect(selectedPreset(PLUGIN)).toBeUndefined();
  });

  it('ignores stored presets it cannot read', async () => {
    await setSettingValue(id('$presets'), [{ name: 'ok', values: {} }, 7, {}]);
    expect(settingPresets(PLUGIN)).toEqual([{ name: 'ok', values: {} }]);
  });
});
