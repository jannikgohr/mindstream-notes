import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Binding-backed settings — the ones whose value lives outside the store
 * (autostart, the tray, window decorations) rather than in localStorage.
 *
 * Their own file because the bindings have to be replaced with controllable
 * ones before the store module is imported: it hydrates from them at import
 * time, and the real ones talk to Tauri.
 */
const binding = vi.hoisted(() => ({
  get: vi.fn(async (): Promise<unknown> => true),
  set: vi.fn(async (_value: unknown): Promise<void> => {}),
  apply: vi.fn(),
  onDemand: {
    get: vi.fn(async (): Promise<unknown> => 'lazy'),
    set: vi.fn(async (_value: unknown): Promise<void> => {})
  }
}));

/** Two real setting ids, so the schema lookups behind them still resolve. */
const BOUND = 'general.closeToTray';
const LAZY = 'general.startOnLogin';

vi.mock('./registry.svelte', () => ({
  SETTING_BINDINGS: {
    [BOUND]: {
      get: binding.get,
      set: binding.set,
      apply: binding.apply,
      document: 'desktop'
    },
    [LAZY]: {
      hydrate: 'on-demand',
      get: binding.onDemand.get,
      set: binding.onDemand.set
    }
  },
  CUSTOM_COMPONENT_LOADERS: {},
  SETTING_ACTIONS: {},
  INFO_VALUES: {},
  SETTING_OPTION_FILTERS: {}
}));

async function load() {
  vi.resetModules();
  return await import('./store.svelte');
}

beforeEach(() => {
  localStorage.clear();
  binding.get.mockReset();
  binding.get.mockResolvedValue(true);
  binding.set.mockReset();
  binding.set.mockResolvedValue(undefined);
  binding.apply.mockReset();
  binding.onDemand.get.mockReset();
  binding.onDemand.get.mockResolvedValue('lazy');
});

describe('hydration', () => {
  it('fills the cache from every startup binding', async () => {
    const store = await load();
    await store.hydrateSettings('startup');
    expect(store.getSettingValue(BOUND)).toBe(true);
  });

  it('leaves on-demand bindings until something asks', async () => {
    const store = await load();
    await store.hydrateSettings('startup');
    expect(binding.onDemand.get).not.toHaveBeenCalled();

    await store.hydrateSettings('all');
    expect(store.getSettingValue(LAZY)).toBe('lazy');
  });

  it('logs and carries on when one binding fails', async () => {
    // One unavailable source must not stop the rest of the dialog from
    // hydrating — outside Tauri several of them throw.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    binding.get.mockRejectedValue(new Error('no autostart plugin'));

    const store = await load();
    await expect(store.hydrateSettings('all')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    expect(store.getSettingValue(LAZY)).toBe('lazy');
    warn.mockRestore();
  });
});

describe('refreshSetting', () => {
  it('ignores a delayed read after a newer write, including runtime effects', async () => {
    const store = await load();
    await store.hydrateSettings();
    let resolveRead!: (value: unknown) => void;
    binding.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );
    const refresh = store.refreshSetting(BOUND);
    binding.get.mockResolvedValue(true);
    await store.setSettingValue(BOUND, true);
    binding.apply.mockClear();
    resolveRead(false);
    await refresh;
    expect(store.getSettingValue(BOUND)).toBe(true);
    expect(binding.apply).not.toHaveBeenCalled();
  });

  it('ignores an older refresh that finishes after the latest refresh', async () => {
    const store = await load();
    await store.hydrateSettings();
    let resolveRead!: (value: unknown) => void;
    binding.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );
    const old = store.refreshSetting(BOUND);
    binding.get.mockResolvedValue(false);
    await store.refreshSetting(BOUND);
    binding.apply.mockClear();
    resolveRead(true);
    await old;
    expect(store.getSettingValue(BOUND)).toBe(false);
    expect(binding.apply).not.toHaveBeenCalled();
  });

  it('refreshes desktop bindings without consulting the OS autostart plugin', async () => {
    const store = await load();
    binding.get.mockResolvedValue(false);
    await store.hydrateSettings('desktop');
    expect(store.getSettingValue(BOUND)).toBe(false);
    expect(binding.onDemand.get).not.toHaveBeenCalled();
  });
  it('re-reads one binding, for an out-of-band change', async () => {
    const store = await load();
    binding.get.mockResolvedValue(false);

    await store.refreshSetting(BOUND);

    expect(store.getSettingValue(BOUND)).toBe(false);
  });

  it('does nothing for a setting with no binding', async () => {
    const store = await load();
    await expect(
      store.refreshSetting('appearance.theme')
    ).resolves.toBeUndefined();
  });

  it('keeps the cached value when the re-read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = await load();
    await store.refreshSetting(BOUND);
    binding.get.mockRejectedValue(new Error('gone'));

    await store.refreshSetting(BOUND);

    expect(store.getSettingValue(BOUND)).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('setSettingValue through a binding', () => {
  it('serializes overlapping writes and keeps newer cache, runtime, and pending state', async () => {
    const store = await load();
    await store.hydrateSettings();
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    binding.set.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        })
    );
    binding.set.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSecond = resolve;
        })
    );
    binding.get.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const first = store.setSettingValue(BOUND, true);
    await vi.waitFor(() => expect(binding.set).toHaveBeenCalledTimes(1));
    const second = store.setSettingValue(BOUND, false);
    binding.apply.mockClear();
    finishFirst();
    await first;
    await vi.waitFor(() => expect(binding.set).toHaveBeenCalledTimes(2));
    expect(store.getSettingValue(BOUND)).toBe(false);
    expect(binding.apply).not.toHaveBeenCalled();
    expect(store.isPending(BOUND)).toBe(true);
    finishSecond();
    await second;
    expect(binding.apply).toHaveBeenLastCalledWith(false);
    expect(store.isPending(BOUND)).toBe(false);
  });

  it('restores runtime effects from the last confirmed value when write and reread fail', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = await load();
    await store.hydrateSettings();
    binding.set.mockRejectedValue(new Error('denied'));
    binding.get.mockRejectedValue(new Error('unreadable'));
    await expect(store.setSettingValue(BOUND, false)).rejects.toThrow('denied');
    expect(store.getSettingValue(BOUND)).toBe(true);
    expect(binding.apply.mock.calls.map(([value]) => value).slice(-2)).toEqual([
      false,
      true
    ]);
    expect(store.isPending(BOUND)).toBe(false);
    error.mockRestore();
  });
  it('writes through and adopts what the source ended up with', async () => {
    // Autostart can silently stay disabled when the OS denies permission,
    // so the value that counts is the one read back.
    const store = await load();
    binding.get.mockResolvedValue(false);

    await store.setSettingValue(BOUND, true);

    expect(binding.set).toHaveBeenCalledWith(true);
    expect(store.getSettingValue(BOUND)).toBe(false);
    expect(store.isPending(BOUND)).toBe(false);
  });

  it('keeps the optimistic value when the read-back fails', async () => {
    const store = await load();
    await store.setSettingValue(BOUND, true);
    binding.get.mockRejectedValue(new Error('read failed'));

    await store.setSettingValue(BOUND, false);

    expect(store.getSettingValue(BOUND)).toBe(false);
  });

  it('rolls the cache back when the write fails, so the UI does not lie', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = await load();
    await store.setSettingValue(BOUND, true);
    binding.set.mockRejectedValue(new Error('denied'));

    await expect(store.setSettingValue(BOUND, false)).rejects.toThrow('denied');

    expect(store.getSettingValue(BOUND)).toBe(true);
    expect(store.isPending(BOUND)).toBe(false);
    error.mockRestore();
  });

  it('resets a binding-backed setting through its binding', async () => {
    const store = await load();
    await store.resetSettingValue(BOUND);
    expect(binding.set).toHaveBeenCalled();
  });
});
