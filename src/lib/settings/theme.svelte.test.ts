import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listThemePresets = vi.fn();
vi.mock('$lib/api/theme-presets', () => ({
  listThemePresets: () => listThemePresets()
}));

import { BUILTIN_PRESETS, THEME_CACHE_KEY } from './theme-presets';

/** The catalog reads the appearance cache once, when the module loads. */
async function loadCatalog() {
  vi.resetModules();
  return import('./theme.svelte');
}

beforeEach(() => {
  localStorage.clear();
  listThemePresets.mockReset();
});

afterEach(() => {
  localStorage.clear();
});

describe('theme catalog', () => {
  it('starts with the built-in presets when nothing is cached', async () => {
    const { themeCatalog } = await loadCatalog();
    expect(themeCatalog.presets).toEqual(BUILTIN_PRESETS);
    expect(themeCatalog.error).toBe('');
  });

  it('includes a cached user preset before the native catalog answers', async () => {
    const custom = { ...BUILTIN_PRESETS[0], id: 'custom', name: 'Custom' };
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ preset: custom }));
    const { themeCatalog } = await loadCatalog();
    expect(themeCatalog.presets).toEqual([...BUILTIN_PRESETS, custom]);
  });

  it('does not duplicate a cached built-in preset', async () => {
    localStorage.setItem(
      THEME_CACHE_KEY,
      JSON.stringify({ preset: BUILTIN_PRESETS[1] })
    );
    const { themeCatalog } = await loadCatalog();
    expect(themeCatalog.presets).toEqual(BUILTIN_PRESETS);
  });

  it('ignores a corrupt cache', async () => {
    localStorage.setItem(THEME_CACHE_KEY, '{not json');
    const { themeCatalog } = await loadCatalog();
    expect(themeCatalog.presets).toEqual(BUILTIN_PRESETS);
  });

  it('replaces the catalog with the native presets and clears a prior error', async () => {
    const { themeCatalog, refreshThemePresets } = await loadCatalog();
    listThemePresets.mockRejectedValueOnce(new Error('catalog unreadable'));
    await refreshThemePresets();
    expect(themeCatalog.error).toBe('catalog unreadable');
    expect(themeCatalog.presets).toEqual(BUILTIN_PRESETS);
    const custom = { ...BUILTIN_PRESETS[0], id: 'custom' };
    listThemePresets.mockResolvedValueOnce([...BUILTIN_PRESETS, custom]);
    await refreshThemePresets();
    expect(themeCatalog.presets).toEqual([...BUILTIN_PRESETS, custom]);
    expect(themeCatalog.error).toBe('');
  });

  it('keeps only the newest answer when refreshes overlap', async () => {
    const { themeCatalog, refreshThemePresets } = await loadCatalog();
    let answerFirst: (presets: unknown) => void = () => {};
    let failFirst: (error: Error) => void = () => {};
    listThemePresets
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            failFirst = reject;
          })
      )
      .mockResolvedValueOnce(BUILTIN_PRESETS.slice(0, 1));
    const stale = refreshThemePresets();
    const staleFailure = refreshThemePresets();
    await refreshThemePresets();
    answerFirst([...BUILTIN_PRESETS]);
    failFirst(new Error('late failure'));
    await Promise.all([stale, staleFailure]);
    expect(themeCatalog.presets).toEqual(BUILTIN_PRESETS.slice(0, 1));
    expect(themeCatalog.error).toBe('');
  });
});
