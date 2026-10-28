import { beforeEach, describe, expect, it, vi } from 'vitest';

const { values, getSettingValue, setSettingValue, resetSettingValue } =
  vi.hoisted(() => {
    const values = new Map<string, unknown>();
    return {
      values,
      getSettingValue: vi.fn((id: string) => values.get(id)),
      setSettingValue: vi.fn(async (id: string, value: unknown) => {
        values.set(id, value);
      }),
      resetSettingValue: vi.fn(async (id: string) => {
        values.delete(id);
      })
    };
  });

vi.mock('$lib/settings/store.svelte', () => ({
  getSettingValue,
  setSettingValue,
  resetSettingValue
}));

import {
  EMBED_ALLOWED_HOSTS_SETTING,
  allowEmbedHost,
  allowedEmbedHosts,
  removeAllowedEmbedHost
} from './embed-allowed-hosts';

beforeEach(() => {
  values.clear();
  setSettingValue.mockClear();
  resetSettingValue.mockClear();
});

describe('allowed embed hosts', () => {
  it('reads an unset or malformed setting as no hosts', () => {
    expect(allowedEmbedHosts()).toEqual([]);
    values.set(EMBED_ALLOWED_HOSTS_SETTING, 'example.com');
    expect(allowedEmbedHosts()).toEqual([]);
  });

  it('adds a host once', async () => {
    await allowEmbedHost('example.com');
    await allowEmbedHost('grafana.example.com');
    await allowEmbedHost('example.com');
    expect(allowedEmbedHosts()).toEqual(['example.com', 'grafana.example.com']);
    expect(setSettingValue).toHaveBeenCalledTimes(2);
  });

  it('removes a host and keeps the rest', async () => {
    values.set(EMBED_ALLOWED_HOSTS_SETTING, ['a.test', 'b.test']);
    await removeAllowedEmbedHost('a.test');
    expect(allowedEmbedHosts()).toEqual(['b.test']);
    expect(resetSettingValue).not.toHaveBeenCalled();
  });

  it('clears the setting when the last host goes', async () => {
    values.set(EMBED_ALLOWED_HOSTS_SETTING, ['a.test']);
    await removeAllowedEmbedHost('a.test');
    expect(resetSettingValue).toHaveBeenCalledWith(EMBED_ALLOWED_HOSTS_SETTING);
    expect(values.has(EMBED_ALLOWED_HOSTS_SETTING)).toBe(false);
  });
});
