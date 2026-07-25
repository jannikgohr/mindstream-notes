import { afterEach, describe, expect, it } from 'vitest';
import { registerPlugin, resetPluginRegistry } from './registry.svelte';
import {
  pluginOverview,
  pluginsWithSettings,
  setPluginEnabledAdmin
} from './manage.svelte';

// Outside Tauri (jsdom), the backend calls no-op, so these exercise the
// registry-derived view and the optimistic enable/disable path.

function withSettings(id: string) {
  registerPlugin({
    id,
    name: `Plugin ${id}`,
    version: '1.2.3',
    runtime: 'manifest-only',
    permissions: ['templates.contribute', 'notes.create'],
    contributes: {
      i18n: {
        en: { 'settings.general.title': 'General', 'settings.x.label': 'X' }
      },
      noteTemplates: [
        {
          id: 'meeting',
          labelKey: 'settings.x.label',
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
              id: 'x',
              labelKey: 'settings.x.label',
              scope: 'D',
              type: 'toggle',
              default: true
            }
          ]
        }
      ]
    }
  });
}

function noSettings(id: string) {
  registerPlugin({
    id,
    name: `Plugin ${id}`,
    version: '0.1.0',
    runtime: 'manifest-only',
    permissions: [],
    contributes: {}
  });
}

afterEach(() => resetPluginRegistry());

describe('pluginOverview', () => {
  it('lists every installed plugin with name, version, source and settings flag', () => {
    withSettings('com.a.plugin');
    noSettings('com.b.plugin');
    const overview = pluginOverview();
    expect(overview).toHaveLength(2);
    const a = overview.find((e) => e.id === 'com.a.plugin');
    expect(a?.name).toBe('Plugin com.a.plugin');
    expect(a?.version).toBe('1.2.3');
    expect(a?.source).toBe('builtin');
    expect(a?.enabled).toBe(true);
    expect(a?.hasSettings).toBe(true);
    expect(overview.find((e) => e.id === 'com.b.plugin')?.hasSettings).toBe(
      false
    );
  });

  it('includes disabled plugins so they can be re-enabled', async () => {
    withSettings('com.a.plugin');
    await setPluginEnabledAdmin('com.a.plugin', false);
    const overview = pluginOverview();
    expect(overview).toHaveLength(1);
    expect(overview[0].enabled).toBe(false);
  });
});

describe('pluginsWithSettings', () => {
  it('returns only enabled plugins that contribute settings', () => {
    withSettings('com.a.plugin');
    noSettings('com.b.plugin');
    expect(pluginsWithSettings().map((p) => p.id)).toEqual(['com.a.plugin']);
  });

  it('drops a plugin once it is disabled', async () => {
    withSettings('com.a.plugin');
    expect(pluginsWithSettings()).toHaveLength(1);
    await setPluginEnabledAdmin('com.a.plugin', false);
    expect(pluginsWithSettings()).toHaveLength(0);
  });
});
