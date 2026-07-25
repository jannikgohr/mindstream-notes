import { afterEach, describe, expect, it } from 'vitest';
import { loadBuiltinPlugins } from './load';
import { BUILTIN_PLUGIN_MANIFESTS } from './builtin';
import {
  allPlugins,
  enabledPlugins,
  pluginLoadError,
  pluginTemplates,
  resetPluginRegistry
} from './registry.svelte';
import type { PluginManifest } from './types';

afterEach(() => resetPluginRegistry());

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
