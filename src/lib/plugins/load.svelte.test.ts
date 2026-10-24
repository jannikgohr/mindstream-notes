import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { isTauri, pluginsDiscover, listen, refreshPluginAdmin } = vi.hoisted(
  () => ({
    isTauri: vi.fn(),
    pluginsDiscover: vi.fn(),
    listen: vi.fn(),
    refreshPluginAdmin: vi.fn()
  })
);
vi.mock('$lib/api/core', async (orig) => {
  const actual = await orig<typeof import('$lib/api/core')>();
  return { ...actual, isTauri };
});
vi.mock('$lib/api/plugins', () => ({ pluginsDiscover }));
vi.mock('$lib/api/events', async (orig) => {
  const actual = await orig<typeof import('$lib/api/events')>();
  return { ...actual, listen };
});
vi.mock('./manage.svelte', () => ({ refreshPluginAdmin }));

import { loadPlugins, watchPluginChanges } from './load';
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
    manifestVersion: 2,
    id,
    name: 'Core Templates',
    version: '1.0.0',
    runtime: 'manifest-only',
    permissions: ['notes.create'],
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
  listen.mockReset();
  refreshPluginAdmin.mockReset();
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

  it('removes contributions when a shared package disappears', async () => {
    isTauri.mockReturnValue(true);
    pluginsDiscover.mockResolvedValue([view({ enabled: true })]);
    await loadPlugins();
    expect(enabledPlugins()).toHaveLength(1);
    pluginsDiscover.mockResolvedValue([]);
    await loadPlugins();
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

describe('watchPluginChanges', () => {
  /** Resolve the listener registration and hand back the change handler. */
  async function subscribe(): Promise<{
    notify: () => void;
    unlisten: ReturnType<typeof vi.fn>;
    stop: () => void;
  }> {
    const unlisten = vi.fn();
    let handler: (() => void) | undefined;
    listen.mockImplementation((_event: string, next: () => void) => {
      handler = next;
      return Promise.resolve(unlisten);
    });
    const stop = watchPluginChanges();
    await vi.waitFor(() => expect(handler).toBeDefined());
    return { notify: () => handler?.(), unlisten, stop };
  }

  it('does nothing outside the desktop runtime', () => {
    isTauri.mockReturnValue(false);
    watchPluginChanges()();
    expect(listen).not.toHaveBeenCalled();
  });

  it('reloads the registry and the admin overview on every root change', async () => {
    isTauri.mockReturnValue(true);
    pluginsDiscover.mockResolvedValue([view({ enabled: true })]);
    refreshPluginAdmin.mockResolvedValue(undefined);
    const { notify, unlisten, stop } = await subscribe();
    expect(listen).toHaveBeenCalledWith(
      'plugins-changed',
      expect.any(Function)
    );
    notify();
    await vi.waitFor(() => expect(refreshPluginAdmin).toHaveBeenCalledTimes(1));
    expect(pluginsDiscover).toHaveBeenCalledTimes(1);
    expect(pluginById(CORE_ID)?.enabled).toBe(true);
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('coalesces changes that arrive during a reload into one more pass', async () => {
    isTauri.mockReturnValue(true);
    let release: () => void = () => {};
    pluginsDiscover
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve([]);
          })
      )
      .mockResolvedValue([]);
    refreshPluginAdmin.mockResolvedValue(undefined);
    const { notify, stop } = await subscribe();
    notify();
    await vi.waitFor(() => expect(pluginsDiscover).toHaveBeenCalledTimes(1));
    notify();
    notify();
    release();
    await vi.waitFor(() => expect(refreshPluginAdmin).toHaveBeenCalledTimes(2));
    expect(pluginsDiscover).toHaveBeenCalledTimes(2);
    stop();
  });

  it('unsubscribes a listener that registers after the watcher stopped', async () => {
    isTauri.mockReturnValue(true);
    const unlisten = vi.fn();
    let register: (stop: () => void) => void = () => {};
    listen.mockReturnValue(
      new Promise((resolve) => {
        register = resolve;
      })
    );
    const stop = watchPluginChanges();
    stop();
    await vi.waitFor(() => expect(listen).toHaveBeenCalled());
    register(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it('reports a listener that cannot be registered', async () => {
    isTauri.mockReturnValue(true);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    listen.mockRejectedValue(new Error('no event bus'));
    const stop = watchPluginChanges();
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        '[plugins] change listener failed',
        expect.any(Error)
      )
    );
    stop();
    error.mockRestore();
  });
});
