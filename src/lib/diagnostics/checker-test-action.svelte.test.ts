import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginTextCheckerContribution } from '$lib/plugins/types';

const contributions = vi.hoisted(
  () => [] as { pluginId: string; checker: PluginTextCheckerContribution }[]
);
const settings = vi.hoisted(() => new Map<string, unknown>());
const actions = vi.hoisted(() => new Map<string, () => void | Promise<void>>());
const notifications = vi.hoisted(() => [] as Record<string, unknown>[]);
const testConnection = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, detail: '42 languages available' }))
);

vi.mock('$lib/plugins/registry.svelte', () => ({
  pluginTextCheckers: () => contributions
}));
vi.mock('$lib/settings/store.svelte', () => ({
  getSettingValue: (id: string) => settings.get(id)
}));
vi.mock('$lib/settings/registry.svelte', () => ({
  registerSettingAction: (id: string, run: () => void | Promise<void>) =>
    actions.set(id, run)
}));
vi.mock('$lib/notifications/store.svelte', () => ({
  upsertNotification: (n: Record<string, unknown>) => notifications.push(n)
}));
vi.mock('$lib/plugins/plugin-i18n', () => ({
  resolvePluginString: (_id: string, key: string) => key
}));
vi.mock('$lib/api/spellcheck', () => ({
  languagetoolTestConnection: testConnection
}));

const checker: PluginTextCheckerContribution = {
  id: 'grammar',
  kinds: ['grammar'],
  protocol: 'languagetool',
  endpointSetting: 'endpoint',
  apiKeySetting: 'api-key',
  usernameSetting: 'username'
};

const ACTION = 'plugins.com.example.lt.textChecker.test';

async function load() {
  vi.resetModules();
  const mod = await import('./checker-test-action.svelte');
  mod.syncCheckerTestActions();
  return mod;
}

beforeEach(() => {
  contributions.length = 0;
  notifications.length = 0;
  settings.clear();
  actions.clear();
  testConnection.mockClear();
  testConnection.mockResolvedValue({
    ok: true,
    detail: '42 languages available'
  });
  contributions.push({ pluginId: 'com.example.lt', checker });
});

describe('syncCheckerTestActions', () => {
  it('registers an action per contributed checker', async () => {
    await load();
    expect([...actions.keys()]).toEqual([ACTION]);
  });

  it('registers nothing when no plugin contributes a checker', async () => {
    contributions.length = 0;
    await load();
    expect(actions.size).toBe(0);
  });

  it('reports success with the server detail', async () => {
    settings.set('plugins.com.example.lt.endpoint', 'http://localhost:8081');
    await load();
    await actions.get(ACTION)!();

    expect(notifications).toHaveLength(1);
    expect(notifications[0].data).toEqual({
      title: 'test.ok',
      message: '42 languages available'
    });
  });

  it('reports failure with the reason', async () => {
    settings.set('plugins.com.example.lt.endpoint', 'http://localhost:9999');
    testConnection.mockResolvedValue({
      ok: false,
      detail: 'connection refused'
    });
    await load();
    await actions.get(ACTION)!();

    expect(notifications[0].data).toEqual({
      title: 'test.failed',
      message: 'connection refused'
    });
  });

  it('does not call the server when no endpoint is set', async () => {
    // Testing an unconfigured server should explain that, not produce a
    // network error the user has to interpret.
    await load();
    await actions.get(ACTION)!();

    expect(testConnection).not.toHaveBeenCalled();
    expect(notifications[0].data).toMatchObject({ title: 'test.failed' });
  });

  it('passes the configured credentials through', async () => {
    settings.set('plugins.com.example.lt.endpoint', 'https://api.example.com');
    settings.set('plugins.com.example.lt.api-key', 'secret');
    settings.set('plugins.com.example.lt.username', 'me@example.com');
    await load();
    await actions.get(ACTION)!();

    expect(testConnection).toHaveBeenCalledWith({
      endpoint: 'https://api.example.com',
      apiKey: 'secret',
      username: 'me@example.com'
    });
  });

  it('omits credentials that are blank', async () => {
    settings.set('plugins.com.example.lt.endpoint', 'http://localhost:8081');
    settings.set('plugins.com.example.lt.api-key', '   ');
    await load();
    await actions.get(ACTION)!();

    expect(testConnection).toHaveBeenCalledWith({
      endpoint: 'http://localhost:8081',
      apiKey: undefined,
      username: undefined
    });
  });

  it('replaces the previous result instead of stacking', async () => {
    settings.set('plugins.com.example.lt.endpoint', 'http://localhost:8081');
    await load();
    await actions.get(ACTION)!();
    await actions.get(ACTION)!();

    expect(notifications).toHaveLength(2);
    expect(notifications[0].id).toBe(notifications[1].id);
  });
});
