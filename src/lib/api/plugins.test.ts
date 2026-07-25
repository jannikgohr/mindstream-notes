import { describe, expect, it } from 'vitest';
import { parsePluginRecord, pluginsList, pluginsUpsert } from './plugins';

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

  it('pluginsUpsert synthesizes an enabled record from the input', async () => {
    const rec = await pluginsUpsert({
      id: 'com.example.plugin',
      version: '2.0.0',
      checksum: 'deadbeef',
      source: 'builtin',
      permissions: ['notes.create']
    });
    expect(rec.enabled).toBe(true);
    expect(rec.acceptedHash).toBe('deadbeef');
    expect(rec.version).toBe('2.0.0');
    expect(rec.grantedPermissions).toEqual(['notes.create']);
  });
});
