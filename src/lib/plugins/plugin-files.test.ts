import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { isTauri, pluginsReadFile } = vi.hoisted(() => ({
  isTauri: vi.fn(),
  pluginsReadFile: vi.fn()
}));
vi.mock('$lib/api/core', () => ({ isTauri }));
vi.mock('$lib/api/plugins', () => ({ pluginsReadFile }));

import { readPluginFile } from './plugin-files';

const CORE_ID = 'com.mindstream.templates.core';

beforeEach(() => {
  isTauri.mockReset();
  pluginsReadFile.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('readPluginFile', () => {
  it('delegates to the backend under Tauri', async () => {
    isTauri.mockReturnValue(true);
    pluginsReadFile.mockResolvedValue('backend contents');
    await expect(readPluginFile(CORE_ID, 'docs/x.md')).resolves.toBe(
      'backend contents'
    );
    expect(pluginsReadFile).toHaveBeenCalledWith(CORE_ID, 'docs/x.md');
  });

  it('reads a bundled core-plugin asset from the build-time glob in the browser', async () => {
    isTauri.mockReturnValue(false);
    const md = await readPluginFile(CORE_ID, 'docs/getting-started.md');
    expect(md).toBeTruthy();
    expect(typeof md).toBe('string');
    expect(pluginsReadFile).not.toHaveBeenCalled();
  });

  it('returns null for an unknown plugin id', async () => {
    isTauri.mockReturnValue(false);
    await expect(readPluginFile('com.unknown', 'a.md')).resolves.toBeNull();
  });

  it('returns null for a missing file in a known bundled plugin', async () => {
    isTauri.mockReturnValue(false);
    await expect(
      readPluginFile(CORE_ID, 'does/not/exist.md')
    ).resolves.toBeNull();
  });
});
