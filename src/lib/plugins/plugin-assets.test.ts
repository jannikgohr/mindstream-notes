import { beforeEach, describe, expect, it, vi } from 'vitest';

const readPluginFile = vi.hoisted(() => vi.fn());
vi.mock('./plugin-files', () => ({ readPluginFile }));

import { loadPluginIcon, svgMaskValue } from './plugin-assets';

beforeEach(() => readPluginFile.mockReset());

describe('loadPluginIcon', () => {
  it('returns the SVG source for a valid bundled icon', async () => {
    readPluginFile.mockResolvedValue('<svg viewBox="0 0 1 1"></svg>');
    await expect(loadPluginIcon('com.x', 'icon.svg')).resolves.toContain(
      '<svg'
    );
  });

  it('returns null when the file is missing', async () => {
    readPluginFile.mockResolvedValue(null);
    await expect(loadPluginIcon('com.x', 'icon.svg')).resolves.toBeNull();
  });

  it('rejects an implausibly large icon', async () => {
    readPluginFile.mockResolvedValue('<svg>' + 'a'.repeat(64 * 1024));
    await expect(loadPluginIcon('com.x', 'icon.svg')).resolves.toBeNull();
  });

  it('rejects content that is not an <svg> root', async () => {
    readPluginFile.mockResolvedValue('<html><body>nope</body></html>');
    await expect(loadPluginIcon('com.x', 'icon.svg')).resolves.toBeNull();
  });
});

describe('svgMaskValue', () => {
  it('produces a url("data:image/svg+xml,...") value with quotes encoded', () => {
    const out = svgMaskValue(`<svg a='1' b="2"></svg>`);
    expect(out.startsWith('url("data:image/svg+xml,')).toBe(true);
    expect(out.endsWith('")')).toBe(true);
    // Raw single/double quotes must be percent-encoded so they can't break out
    // of the CSS url("...") wrapper.
    expect(out).not.toMatch(/[^%]'/);
    expect(out.slice('url("'.length)).not.toContain('"' + 'data');
    expect(out).toContain('%27');
    expect(out).toContain('%22');
  });
});
