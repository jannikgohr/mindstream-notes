import { describe, expect, it } from 'vitest';
import { parsePluginRecord, pluginsDiscover, pluginsList } from './plugins';

const RAW = {
  id: 'com.example.plugin',
  version: '1.0.0',
  enabled: true,
  source: 'builtin',
  sourcePath: null,
  acceptedHash: 'abcd1234',
  grantedPermissions: ['templates.contribute', 'notes.create'],
  lastLoadError: null,
  installedAt: '2026-07-25T00:00:00Z',
  updatedAt: '2026-07-25T00:00:00Z'
};

describe('parsePluginRecord', () => {
  it('parses a well-formed record', () => {
    const rec = parsePluginRecord(RAW);
    expect(rec.id).toBe('com.example.plugin');
    expect(rec.enabled).toBe(true);
    expect(rec.grantedPermissions).toHaveLength(2);
    expect(rec.sourcePath).toBeNull();
  });

  it('throws on a missing field', () => {
    const { acceptedHash: _omit, ...missing } = RAW;
    expect(() => parsePluginRecord(missing)).toThrow(/acceptedHash/);
  });
});

describe('no-Tauri fallbacks', () => {
  it('pluginsList returns an empty array', async () => {
    await expect(pluginsList()).resolves.toEqual([]);
  });

  it('pluginsDiscover returns an empty array (browser loads its own fallback)', async () => {
    await expect(pluginsDiscover()).resolves.toEqual([]);
  });
});
