import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSettingValue } from '$lib/settings/store.svelte';
import {
  setLanguage,
  tDescription,
  tLabel,
  tValue
} from '$lib/settings/i18n.svelte';
import {
  registerPlugin,
  resetPluginRegistry,
  setPluginEnabled
} from './registry.svelte';
import {
  PLUGINS_CATEGORY_ID,
  installPluginSettingsBridge,
  pluginSettingDef,
  pluginSettingsCategory,
  pluginSettingsSectionsFor,
  uninstallPluginSettingsBridge
} from './settings-bridge';

const PLUGIN_ID = 'com.example.templates';
const SETTING_ID = `plugins.${PLUGIN_ID}.open-on-create`;
const SECTION_ID = `plugins.${PLUGIN_ID}.general`;

function register(): void {
  registerPlugin({
    id: PLUGIN_ID,
    name: 'Example',
    version: '1.0.0',
    runtime: 'manifest-only',
    permissions: ['notes.create'],
    contributes: {
      i18n: {
        en: {
          'settings.general.title': 'Core Templates',
          'settings.openOnCreate.label': 'Open new template notes',
          'settings.openOnCreate.description': 'Open right after creating',
          'settings.defaultMode.label': 'Default mode',
          'settings.defaultMode.preview': 'Live Preview'
        },
        de: {
          'settings.general.title': 'Basisvorlagen',
          'settings.openOnCreate.label': 'Neue Vorlagennotizen öffnen',
          'settings.defaultMode.preview': 'Live-Vorschau'
        }
      },
      noteTemplates: [
        {
          id: 'meeting',
          labelKey: 'settings.general.title',
          noteKind: 'markdown',
          titleTemplate: '{{date}}',
          bodyTemplate: '# {{date}}'
        }
      ],
      settings: [
        {
          sectionId: 'general',
          titleKey: 'settings.general.title',
          settings: [
            {
              id: 'open-on-create',
              labelKey: 'settings.openOnCreate.label',
              descriptionKey: 'settings.openOnCreate.description',
              scope: 'D',
              type: 'toggle',
              default: true
            },
            {
              id: 'default-mode',
              labelKey: 'settings.defaultMode.label',
              scope: 'D',
              type: 'select',
              default: 'wysiwyg',
              options: ['wysiwyg'],
              optionLabelKeys: {
                wysiwyg: 'settings.defaultMode.preview'
              }
            }
          ]
        }
      ]
    }
  });
}

beforeEach(() => {
  register();
  installPluginSettingsBridge();
});
afterEach(() => {
  uninstallPluginSettingsBridge();
  resetPluginRegistry();
  setLanguage('en');
});

describe('pluginSettingsCategory', () => {
  it('builds a Plugins category with namespaced section + setting ids', () => {
    const cat = pluginSettingsCategory();
    expect(cat?.id).toBe(PLUGINS_CATEGORY_ID);
    expect(cat?.sections).toHaveLength(1);
    expect(cat?.sections[0].id).toBe(SECTION_ID);
    expect(cat?.sections[0].settings[0].id).toBe(SETTING_ID);
    expect(cat?.sections[0].settings[0].scope).toBe('D');
  });

  it('returns null when no enabled plugin contributes settings', () => {
    setPluginEnabled(PLUGIN_ID, false);
    expect(pluginSettingsCategory()).toBeNull();
  });
});

describe('store integration', () => {
  it('resolves a plugin setting default through the store', () => {
    expect(getSettingValue(SETTING_ID)).toBe(true);
  });

  it('stops resolving once the plugin is disabled', () => {
    setPluginEnabled(PLUGIN_ID, false);
    expect(getSettingValue(SETTING_ID)).toBeUndefined();
  });
});

describe('i18n integration', () => {
  it('resolves setting label + description via plugin i18n', () => {
    expect(tLabel('settings', SETTING_ID)).toBe('Open new template notes');
    expect(tDescription('settings', SETTING_ID)).toBe(
      'Open right after creating'
    );
  });

  it('resolves the section title via plugin i18n', () => {
    expect(tLabel('sections', SECTION_ID)).toBe('Core Templates');
  });

  it('follows the active language, falling back to english', () => {
    setLanguage('de');
    expect(tLabel('settings', SETTING_ID)).toBe('Neue Vorlagennotizen öffnen');
    // No German description in the bundle → english fallback.
    expect(tDescription('settings', SETTING_ID)).toBe(
      'Open right after creating'
    );
  });

  it('resolves plugin setting option labels via plugin i18n', () => {
    const modeSettingId = `plugins.${PLUGIN_ID}.default-mode`;
    expect(tValue(modeSettingId, 'wysiwyg')).toBe('Live Preview');
    setLanguage('de');
    expect(tValue(modeSettingId, 'wysiwyg')).toBe('Live-Vorschau');
  });
});

/**
 * One plugin's settings in isolation — what the plugin manager panel renders,
 * as opposed to the combined "Plugins" category in the settings dialog.
 */
describe('pluginSettingsSectionsFor', () => {
  it('returns only the sections the named plugin contributes', () => {
    const sections = pluginSettingsSectionsFor(PLUGIN_ID);
    expect(sections.map((s) => s.id)).toEqual([SECTION_ID]);
    expect(sections[0].settings.map((s) => s.id)).toContain(SETTING_ID);
  });

  it('is empty for a plugin that contributes none', () => {
    expect(pluginSettingsSectionsFor('com.example.other')).toEqual([]);
  });

  it('is empty once the plugin is disabled', () => {
    setPluginEnabled(PLUGIN_ID, false);
    expect(pluginSettingsSectionsFor(PLUGIN_ID)).toEqual([]);
  });
});

describe('pluginSettingDef', () => {
  it('resolves a full plugin setting id to a core setting', () => {
    expect(pluginSettingDef(SETTING_ID)).toMatchObject({
      id: SETTING_ID,
      scope: 'D'
    });
  });

  it('returns nothing for an id no plugin owns', () => {
    expect(pluginSettingDef('plugins.com.example.ghost.x')).toBeUndefined();
    expect(pluginSettingDef('appearance.theme')).toBeUndefined();
  });
});

describe('resolver scopes the bridge does not own', () => {
  it('leaves the category label to the core bundle', () => {
    // Only settings and sections are plugin-owned; anything else falls
    // through so the core i18n keeps answering for it.
    expect(tLabel('categories', PLUGINS_CATEGORY_ID)).not.toBe(
      'Core Templates'
    );
  });

  it('has no description for a section or an unknown setting', () => {
    expect(tDescription('sections', SECTION_ID)).not.toBe(
      'Open right after creating'
    );
    expect(tDescription('settings', 'plugins.com.example.ghost.x')).not.toBe(
      'Open right after creating'
    );
  });

  it('has no label for a section or setting no plugin owns', () => {
    expect(tLabel('sections', 'plugins.com.example.ghost.general')).not.toBe(
      'Core Templates'
    );
    expect(tLabel('settings', 'plugins.com.example.ghost.x')).not.toBe(
      'Open new template notes'
    );
  });

  it('has no option label for a setting that declares none', () => {
    expect(tValue(SETTING_ID, 'true')).not.toBe('Live Preview');
  });
});
