import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginTextCheckerContribution } from '$lib/plugins/types';

const contributions = vi.hoisted(
  () => [] as { pluginId: string; checker: PluginTextCheckerContribution }[]
);
const settings = vi.hoisted(() => new Map<string, unknown>());
const registered = vi.hoisted(() => new Map<string, () => void>());

vi.mock('$lib/plugins/registry.svelte', () => ({
  pluginTextCheckers: () => contributions
}));
vi.mock('$lib/settings/store.svelte', () => ({
  getSettingValue: (id: string) => settings.get(id)
}));
vi.mock('./editor-diagnostics.svelte', () => ({
  registerProvider: (provider: { id: string }) => {
    const off = vi.fn();
    registered.set(provider.id, off);
    return () => {
      off();
      registered.delete(provider.id);
    };
  }
}));
vi.mock('$lib/api/spellcheck', () => ({ languagetoolCheck: vi.fn() }));

const checker = (
  over: Partial<PluginTextCheckerContribution> = {}
): PluginTextCheckerContribution => ({
  id: 'grammar',
  kinds: ['grammar'],
  protocol: 'languagetool',
  endpointSetting: 'endpoint',
  ...over
});

async function load() {
  vi.resetModules();
  return await import('./plugin-checkers.svelte');
}

beforeEach(() => {
  contributions.length = 0;
  settings.clear();
  registered.clear();
});

describe('syncPluginTextCheckers', () => {
  it('registers a contributed checker', async () => {
    contributions.push({ pluginId: 'com.example.lt', checker: checker() });
    const mod = await load();
    mod.syncPluginTextCheckers();
    expect([...registered.keys()]).toEqual(['plugins.com.example.lt.grammar']);
  });

  it('registers nothing when no plugin contributes one', async () => {
    const mod = await load();
    mod.syncPluginTextCheckers();
    expect(registered.size).toBe(0);
  });

  it('is idempotent', async () => {
    // Called on every plugin-state change, so re-registering an unchanged
    // checker would drop its cached findings and re-check every open note.
    contributions.push({ pluginId: 'com.example.lt', checker: checker() });
    const mod = await load();
    mod.syncPluginTextCheckers();
    const first = registered.get('plugins.com.example.lt.grammar');
    mod.syncPluginTextCheckers();
    expect(registered.get('plugins.com.example.lt.grammar')).toBe(first);
    expect(first).not.toHaveBeenCalled();
  });

  it('unregisters a checker whose plugin went away', async () => {
    contributions.push({ pluginId: 'com.example.lt', checker: checker() });
    const mod = await load();
    mod.syncPluginTextCheckers();

    contributions.length = 0;
    mod.syncPluginTextCheckers();
    expect(registered.size).toBe(0);
  });

  it('leaves other checkers alone when one departs', async () => {
    contributions.push(
      { pluginId: 'a', checker: checker() },
      { pluginId: 'b', checker: checker() }
    );
    const mod = await load();
    mod.syncPluginTextCheckers();
    const keep = registered.get('plugins.a.grammar');

    contributions.splice(1, 1);
    mod.syncPluginTextCheckers();

    expect([...registered.keys()]).toEqual(['plugins.a.grammar']);
    expect(keep).not.toHaveBeenCalled();
  });

  it('clears everything on teardown', async () => {
    contributions.push({ pluginId: 'com.example.lt', checker: checker() });
    const mod = await load();
    mod.syncPluginTextCheckers();
    mod.clearPluginTextCheckers();
    expect(registered.size).toBe(0);
  });
});

describe('checkerProviderId', () => {
  it('namespaces the id to its plugin', async () => {
    // Two plugins may both contribute a checker called "grammar".
    const mod = await load();
    expect(mod.checkerProviderId('com.example.lt', 'grammar')).toBe(
      'plugins.com.example.lt.grammar'
    );
  });
});
