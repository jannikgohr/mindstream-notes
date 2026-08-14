import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  list: vi.fn(async () => [] as string[]),
  add: vi.fn(async (_word: string) => {}),
  remove: vi.fn(async (_word: string) => {})
}));
const invalidate = vi.hoisted(() => vi.fn());

vi.mock('$lib/api/spellcheck', () => ({
  customDictionaryList: api.list,
  customDictionaryAdd: api.add,
  customDictionaryRemove: api.remove
}));
vi.mock('./invalidate', () => ({
  invalidateDiagnostics: invalidate,
  subscribeDiagnosticsInvalidated: () => () => {}
}));

/**
 * Reloaded per test because the mirror is module state — the point of it is
 * that lookups are synchronous and shared, which also means it survives
 * between tests unless the module is reset.
 */
async function load() {
  vi.resetModules();
  return await import('./custom-dictionary.svelte');
}

beforeEach(() => {
  api.list.mockClear();
  api.list.mockResolvedValue([]);
  api.add.mockClear();
  api.remove.mockClear();
  invalidate.mockClear();
});

describe('custom dictionary', () => {
  it('knows nothing before it is loaded', async () => {
    const mod = await load();
    expect(mod.isCustomWord('Mindstream')).toBe(false);
  });

  it('mirrors the stored words', async () => {
    api.list.mockResolvedValue(['Mindstream', 'Etebase']);
    const mod = await load();
    await mod.loadCustomDictionary();
    expect(mod.isCustomWord('Mindstream')).toBe(true);
    expect(mod.customDictionary.words).toEqual(['Mindstream', 'Etebase']);
  });

  it('only loads once unless forced', async () => {
    const mod = await load();
    await mod.loadCustomDictionary();
    await mod.loadCustomDictionary();
    expect(api.list).toHaveBeenCalledTimes(1);

    await mod.loadCustomDictionary(true);
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('shares one fetch between concurrent callers', async () => {
    // The root layout loads it at startup and the settings panel loads it
    // on open; both can start before either finishes.
    const mod = await load();
    await Promise.all([
      mod.loadCustomDictionary(),
      mod.loadCustomDictionary(),
      mod.loadCustomDictionary()
    ]);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  describe('case-insensitive matching', () => {
    // A word added mid-sentence in lowercase must not come back underlined
    // the moment it starts a sentence — which is when the user would notice.
    it('matches a capitalized form of a lowercase entry', async () => {
      api.list.mockResolvedValue(['mindstream']);
      const mod = await load();
      await mod.loadCustomDictionary();
      expect(mod.isCustomWord('Mindstream')).toBe(true);
      expect(mod.isCustomWord('MINDSTREAM')).toBe(true);
    });

    it('matches non-ASCII words regardless of case', async () => {
      api.list.mockResolvedValue(['Ärzteschaft']);
      const mod = await load();
      await mod.loadCustomDictionary();
      expect(mod.isCustomWord('ärzteschaft')).toBe(true);
    });
  });

  describe('adding', () => {
    it('takes effect immediately, before the write resolves', async () => {
      const mod = await load();
      await mod.loadCustomDictionary();
      await mod.addCustomWord('Mindstream');
      expect(mod.isCustomWord('Mindstream')).toBe(true);
      expect(api.add).toHaveBeenCalledWith('Mindstream');
    });

    it('asks the editors to re-check', async () => {
      // Otherwise the squiggle stays until the next keystroke.
      const mod = await load();
      await mod.addCustomWord('Mindstream');
      expect(invalidate).toHaveBeenCalled();
    });

    it('ignores a word it already has', async () => {
      api.list.mockResolvedValue(['Mindstream']);
      const mod = await load();
      await mod.loadCustomDictionary();
      await mod.addCustomWord('mindstream');
      expect(api.add).not.toHaveBeenCalled();
    });

    it('ignores blank input', async () => {
      const mod = await load();
      await mod.addCustomWord('   ');
      expect(api.add).not.toHaveBeenCalled();
    });

    it('trims what it stores', async () => {
      const mod = await load();
      await mod.addCustomWord('  Mindstream  ');
      expect(api.add).toHaveBeenCalledWith('Mindstream');
    });

    it('keeps the list sorted for display', async () => {
      api.list.mockResolvedValue(['banana']);
      const mod = await load();
      await mod.loadCustomDictionary();
      await mod.addCustomWord('Apfel');
      expect(mod.customDictionary.words).toEqual(['Apfel', 'banana']);
    });
  });

  describe('removing', () => {
    it('stops matching and re-checks', async () => {
      api.list.mockResolvedValue(['Mindstream']);
      const mod = await load();
      await mod.loadCustomDictionary();
      await mod.removeCustomWord('Mindstream');

      expect(mod.isCustomWord('Mindstream')).toBe(false);
      expect(mod.customDictionary.words).toEqual([]);
      expect(invalidate).toHaveBeenCalled();
    });

    it('removes whatever casing the user is looking at', async () => {
      api.list.mockResolvedValue(['Mindstream']);
      const mod = await load();
      await mod.loadCustomDictionary();
      await mod.removeCustomWord('MINDSTREAM');
      expect(mod.customDictionary.words).toEqual([]);
    });
  });
});
