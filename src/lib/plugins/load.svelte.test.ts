import { afterEach, describe, expect, it, vi } from 'vitest';

const { pluginsUpsert } = vi.hoisted(() => ({ pluginsUpsert: vi.fn() }));
vi.mock('$lib/api/plugins', () => ({ pluginsUpsert }));

import { loadBuiltinPlugins, syncBuiltinPluginsWithBackend } from './load';
import { BUILTIN_PLUGIN_MANIFESTS } from './builtin';
import {
  allPlugins,
  enabledPlugins,
  pluginById,
  pluginLoadError,
  pluginTemplates,
  resetPluginRegistry
} from './registry.svelte';
import type { PluginManifest } from './types';

afterEach(() => {
  resetPluginRegistry();
  pluginsUpsert.mockReset();
});

describe('loadBuiltinPlugins', () => {
  it('registers the real bundled manifests and their contributions', () => {
    loadBuiltinPlugins(() => true);
    expect(allPlugins().length).toBe(BUILTIN_PLUGIN_MANIFESTS.length);
    // The Core Templates plugin contributes at least the two markdown templates.
    expect(pluginTemplates().length).toBeGreaterThanOrEqual(2);
  });

  it('honours the enablement predicate', () => {
    loadBuiltinPlugins(() => false);
    expect(allPlugins().length).toBe(BUILTIN_PLUGIN_MANIFESTS.length);
    expect(enabledPlugins()).toHaveLength(0);
    expect(pluginTemplates()).toHaveLength(0);
  });

  it('records a load error for a broken manifest without throwing', () => {
    const broken = [
      { id: 'not a valid id', name: 'Broken' } as unknown as PluginManifest
    ];
    expect(() => loadBuiltinPlugins(() => true, broken)).not.toThrow();
    expect(allPlugins()).toHaveLength(0);
    expect(pluginLoadError('not a valid id')).toBeTruthy();
  });

  it('loads the healthy plugins even when one is broken', () => {
    const mixed = [
      ...BUILTIN_PLUGIN_MANIFESTS,
      { id: 'bad' } as unknown as PluginManifest
    ];
    loadBuiltinPlugins(() => true, mixed);
    expect(allPlugins().length).toBe(BUILTIN_PLUGIN_MANIFESTS.length);
    expect(pluginLoadError('bad')).toBeTruthy();
  });
});

describe('syncBuiltinPluginsWithBackend', () => {
  const [manifest] = BUILTIN_PLUGIN_MANIFESTS;

  function record(overrides: Record<string, unknown> = {}) {
    return {
      id: manifest.id,
      version: manifest.version,
      enabled: true,
      source: 'builtin',
      sourcePath: null,
      acceptedHash: 'x',
      grantedPermissions: manifest.permissions,
      lastLoadError: null,
      installedAt: '2026-07-25T00:00:00Z',
      updatedAt: '2026-07-25T00:00:00Z',
      ...overrides
    };
  }

  it('applies the backend enabled flag onto the registry', async () => {
    loadBuiltinPlugins(() => true, [manifest]);
    expect(pluginById(manifest.id)?.enabled).toBe(true);
    pluginsUpsert.mockResolvedValue(record({ enabled: false }));
    await syncBuiltinPluginsWithBackend([manifest]);
    expect(pluginById(manifest.id)?.enabled).toBe(false);
    expect(enabledPlugins()).toHaveLength(0);
  });

  it('records a backend load error (e.g. integrity gate)', async () => {
    loadBuiltinPlugins(() => true, [manifest]);
    pluginsUpsert.mockResolvedValue(
      record({ enabled: false, lastLoadError: 'hash changed' })
    );
    await syncBuiltinPluginsWithBackend([manifest]);
    expect(pluginLoadError(manifest.id)).toBe('hash changed');
  });

  it('skips plugins that never registered on the frontend', async () => {
    // Nothing loaded → nothing to reconcile, and no upsert attempted.
    await syncBuiltinPluginsWithBackend([manifest]);
    expect(pluginsUpsert).not.toHaveBeenCalled();
  });
});
