import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { isTauri, pluginsDiscover } = vi.hoisted(() => ({
  isTauri: vi.fn(),
  pluginsDiscover: vi.fn()
}));
vi.mock('$lib/api/core', async (orig) => {
  const actual = await orig<typeof import('$lib/api/core')>();
  return { ...actual, isTauri };
});
vi.mock('$lib/api/plugins', () => ({ pluginsDiscover }));

import { loadPlugins } from './load';
import {
  allPlugins,
  enabledPlugins,
  pluginById,
  pluginLoadError,
  pluginSettingsSections,
  pluginTemplates,
  resetPluginRegistry
} from './registry.svelte';
import { notificationState } from '$lib/notifications/store.svelte';

const CORE_ID = 'com.mindstream.templates.core';

function validManifest(id = CORE_ID): Record<string, unknown> {
  return {
    id,
    name: 'Core Templates',
    version: '1.0.0',
    runtime: 'manifest-only',
    permissions: ['templates.contribute', 'notes.create'],
    contributes: {
      i18n: { en: { 'templates.meeting.name': 'Meeting' } },
      noteTemplates: [
        {
          id: 'meeting',
          labelKey: 'templates.meeting.name',
          noteKind: 'markdown',
          titleTemplate: '{{date}}',
          bodyTemplate: '# {{date}}'
        }
      ]
    }
  };
}

function view(
  record: Record<string, unknown> = {},
  manifest: unknown = validManifest()
) {
  return {
    record: {
      id: CORE_ID,
      version: '1.0.0',
      enabled: true,
      source: 'installed',
      sourcePath: null,
      acceptedHash: 'x',
      grantedPermissions: [],
      lastLoadError: null,
      installedAt: 't',
      updatedAt: 't',
      ...record
    },
    manifest
  };
}

beforeEach(() => {
  isTauri.mockReset();
  pluginsDiscover.mockReset();
});
afterEach(() => {
  resetPluginRegistry();
  notificationState.items = [];
});

describe('loadPlugins — browser (no backend)', () => {
  it('registers the bundled core plugin from its manifest', async () => {
    isTauri.mockReturnValue(false);
    await loadPlugins();
    const core = pluginById(CORE_ID);
    expect(core?.enabled).toBe(true);
    expect(core?.manifest.name).toBe('Templates');
    // The bundled Templates plugin ships the folder/tag source settings, not
    // premade note templates.
    expect(pluginTemplates()).toHaveLength(0);
    expect(pluginSettingsSections().length).toBeGreaterThanOrEqual(1);
    expect(pluginsDiscover).not.toHaveBeenCalled();
  });
});

describe('loadPlugins — Tauri (backend discovery)', () => {
  it('registers discovered enabled plugins with their contributions', async () => {
    isTauri.mockReturnValue(true);
    pluginsDiscover.mockResolvedValue([view({ enabled: true })]);
    await loadPlugins();
    expect(pluginById(CORE_ID)?.enabled).toBe(true);
    expect(pluginTemplates()).toHaveLength(1);
  });

  it('keeps a disabled plugin registered (for the overview) but contributing nothing', async () => {
    isTauri.mockReturnValue(true);
    pluginsDiscover.mockResolvedValue([
      view({ enabled: false, lastLoadError: 'manifest hash changed' })
    ]);
    await loadPlugins();
    expect(allPlugins()).toHaveLength(1);
    expect(enabledPlugins()).toHaveLength(0);
    expect(pluginTemplates()).toHaveLength(0);
    expect(pluginLoadError(CORE_ID)).toBe('manifest hash changed');
    // A previously-approved plugin that changed (non-empty accepted hash)
    // raises the "re-approval" notification.
    expect(notificationState.items.some((i) => i.kind === 'plugin-gated')).toBe(
      true
    );
  });

  it('raises the separate "new plugin" notification for a never-approved install', async () => {
    isTauri.mockReturnValue(true);
    pluginsDiscover.mockResolvedValue([
      view({
        enabled: false,
        lastLoadError: 'new third-party plugin; approve it to enable',
        // Empty accepted hash marks it as never-approved (vs. changed).
        acceptedHash: ''
      })
    ]);
    await loadPlugins();
    expect(notificationState.items.some((i) => i.kind === 'plugin-new')).toBe(
      true
    );
    expect(notificationState.items.some((i) => i.kind === 'plugin-gated')).toBe(
      false
    );
  });

  it('records an error and skips a plugin whose manifest fails validation', async () => {
    isTauri.mockReturnValue(true);
    pluginsDiscover.mockResolvedValue([view({}, { id: 'not a valid id' })]);
    await loadPlugins();
    expect(allPlugins()).toHaveLength(0);
    expect(pluginLoadError(CORE_ID)).toBeTruthy();
  });

  it('does not throw when discovery itself fails', async () => {
    isTauri.mockReturnValue(true);
    pluginsDiscover.mockRejectedValue(new Error('ipc boom'));
    await expect(loadPlugins()).resolves.toBeUndefined();
    expect(allPlugins()).toHaveLength(0);
  });

  it('falls back to the record id for a gated plugin whose manifest has no name', async () => {
    isTauri.mockReturnValue(true);
    // Manifest omits `name`, so the gate notification uses the record id.
    const nameless = validManifest();
    delete (nameless as Record<string, unknown>).name;
    pluginsDiscover.mockResolvedValue([
      view({ enabled: false, lastLoadError: 'manifest hash changed' }, nameless)
    ]);
    await loadPlugins();
    const gated = notificationState.items.find(
      (i) => i.kind === 'plugin-gated'
    );
    expect(gated).toBeTruthy();
  });

  it('records the load error under <unknown> when neither record nor manifest carry an id', async () => {
    isTauri.mockReturnValue(true);
    // record.id nullish + manifest invalid and idless → applyDiscovered's catch
    // resolves the id via manifestId(manifest) → '<unknown>'.
    pluginsDiscover.mockResolvedValue([
      view({ id: null }, { name: 'Broken', runtime: 'manifest-only' })
    ]);
    await loadPlugins();
    expect(allPlugins()).toHaveLength(0);
    expect(pluginLoadError('<unknown>')).toBeTruthy();
  });
});
