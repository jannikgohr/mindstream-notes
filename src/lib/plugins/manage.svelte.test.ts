import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Backend api is mocked so the Tauri-backed admin paths (list/enable/disable/
// approve/remove) are controllable; the real `isTauri()` is toggled per-block
// via the `__TAURI_INTERNALS__` window key. `./load` is mocked so approve's
// re-discovery is observable without pulling in the real loader.
const api = vi.hoisted(() => ({
  list: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  approve: vi.fn(),
  remove: vi.fn()
}));
vi.mock('$lib/api/plugins', () => ({
  pluginsList: api.list,
  pluginsEnable: api.enable,
  pluginsDisable: api.disable,
  pluginsApprove: api.approve,
  pluginsRemove: api.remove
}));
const loadPlugins = vi.hoisted(() => vi.fn());
vi.mock('./load', () => ({ loadPlugins }));

import { registerPlugin, resetPluginRegistry } from './registry.svelte';
import {
  approvePluginAdmin,
  pluginOverview,
  pluginsWithSettings,
  refreshPluginAdmin,
  removePluginAdmin,
  setPluginEnabledAdmin
} from './manage.svelte';

function setTauri(on: boolean): void {
  if (on) {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  } else {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  }
}

// Outside Tauri (jsdom), the backend calls no-op, so these exercise the
// registry-derived view and the optimistic enable/disable path.

function withSettings(id: string) {
  registerPlugin({
    manifestVersion: 1,
    id,
    name: `Plugin ${id}`,
    version: '1.2.3',
    runtime: 'manifest-only',
    permissions: ['notes.create'],
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
    manifestVersion: 1,
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

describe('Tauri-backed admin', () => {
  beforeEach(() => {
    setTauri(true);
    api.list.mockReset().mockResolvedValue([]);
    api.enable.mockReset();
    api.disable.mockReset();
    api.approve.mockReset().mockResolvedValue(undefined);
    api.remove.mockReset().mockResolvedValue(undefined);
    loadPlugins.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => setTauri(false));

  it('refreshPluginAdmin enriches the overview with backend records', async () => {
    registerPlugin({
      manifestVersion: 1,
      id: 'com.typst.plugin',
      name: 'Typst',
      version: '2.0.0',
      runtime: 'manifest-only',
      author: 'Typst Authors',
      descriptionKey: 'meta.description',
      permissions: [
        'nativeTools.runDeclared',
        'nativeServices.run',

        'notes.create'
      ],
      contributes: {
        i18n: { en: { 'meta.description': 'Typst compiler' } },
        documentation: [{ titleKey: 'meta.description', file: 'README.md' }],
        noteTemplates: [
          {
            id: 'doc',
            labelKey: 'meta.description',
            noteKind: 'markdown',
            titleTemplate: '{{date}}',
            bodyTemplate: '# {{date}}'
          }
        ],
        commands: [
          {
            id: 'compile',
            labelKey: 'meta.description',
            action: { type: 'createTemplateNote', templateId: 'doc' }
          }
        ],
        nativeTools: [{ id: 'typst', binaryName: 'typst' }],
        nativeServices: [
          {
            id: 'preview',
            binaryName: 'tinymist',
            args: ['preview', '{input}'],
            dataUrl: 'http://127.0.0.1:{dataPort}',
            controlUrl: 'ws://127.0.0.1:{controlPort}'
          }
        ]
      }
    });
    api.list.mockResolvedValue([
      {
        id: 'com.typst.plugin',
        version: '2.0.0',
        enabled: true,
        source: 'installed',
        sourcePath: '/p/typst',
        acceptedHash: 'h',
        grantedPermissions: ['nativeTools.run'],
        lastLoadError: 'stale binary',
        signer: 'abcdef',
        signatureStatus: 'valid',
        installedAt: '',
        updatedAt: ''
      }
    ]);
    await refreshPluginAdmin();
    const entry = pluginOverview().find((e) => e.id === 'com.typst.plugin');
    expect(entry?.source).toBe('installed');
    expect(entry?.signatureStatus).toBe('valid');
    expect(entry?.signer).toBe('abcdef');
    expect(entry?.author).toBe('Typst Authors');
    expect(entry?.description).toBe('Typst compiler');
    expect(entry?.loadError).toBe('stale binary');
    expect(entry?.hasCommands).toBe(true);
    expect(entry?.documentation).toHaveLength(1);
    expect(entry?.nativeToolBinaries).toEqual(['typst']);
    expect(entry?.nativeServiceBinaries).toEqual(['tinymist']);
  });

  it('refreshPluginAdmin swallows a backend list failure', async () => {
    api.list.mockRejectedValue(new Error('ipc down'));
    await expect(refreshPluginAdmin()).resolves.toBeUndefined();
  });

  it('setPluginEnabledAdmin persists via the backend and reconciles state', async () => {
    noSettings('com.a.plugin');
    api.disable.mockResolvedValue({ id: 'com.a.plugin', enabled: false });
    await setPluginEnabledAdmin('com.a.plugin', false);
    expect(api.disable).toHaveBeenCalledWith('com.a.plugin');
    expect(pluginOverview()[0].enabled).toBe(false);
  });

  it('setPluginEnabledAdmin keeps the optimistic flip when the backend throws', async () => {
    noSettings('com.a.plugin');
    api.enable.mockRejectedValue(new Error('boom'));
    await setPluginEnabledAdmin('com.a.plugin', false);
    await setPluginEnabledAdmin('com.a.plugin', true);
    // Optimistic flip stands even though persistence failed.
    expect(pluginOverview()[0].enabled).toBe(true);
  });

  it('approvePluginAdmin re-discovers and refreshes after approval', async () => {
    await approvePluginAdmin('com.x.plugin');
    expect(api.approve).toHaveBeenCalledWith('com.x.plugin');
    expect(loadPlugins).toHaveBeenCalled();
    expect(api.list).toHaveBeenCalled();
  });

  it('approvePluginAdmin bails out (no re-discovery) when approval fails', async () => {
    api.approve.mockRejectedValue(new Error('gated'));
    await approvePluginAdmin('com.x.plugin');
    expect(loadPlugins).not.toHaveBeenCalled();
  });

  it('removePluginAdmin unregisters the plugin from the reactive registry', async () => {
    noSettings('com.gone.plugin');
    expect(pluginOverview().some((e) => e.id === 'com.gone.plugin')).toBe(true);
    await removePluginAdmin('com.gone.plugin');
    expect(api.remove).toHaveBeenCalledWith('com.gone.plugin');
    expect(pluginOverview().some((e) => e.id === 'com.gone.plugin')).toBe(
      false
    );
  });

  it('removePluginAdmin keeps the plugin when the backend remove fails', async () => {
    noSettings('com.stay.plugin');
    api.remove.mockRejectedValue(new Error('locked'));
    await removePluginAdmin('com.stay.plugin');
    expect(pluginOverview().some((e) => e.id === 'com.stay.plugin')).toBe(true);
  });
});
