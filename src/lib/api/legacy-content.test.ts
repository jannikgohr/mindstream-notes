import { afterEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args)
}));
import { migrateLegacyContent } from './legacy-content';

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  invoke.mockReset();
});

describe('legacy content migration', () => {
  it('requires native storage for its receipts', async () => {
    await expect(migrateLegacyContent('favourites', '[]')).rejects.toThrow(
      /native storage/
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('forwards the raw browser values and returns the changed note IDs', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValueOnce(['a', 'b']);
    await expect(
      migrateLegacyContent('favourites', '["a","b"]')
    ).resolves.toEqual(['a', 'b']);
    expect(invoke).toHaveBeenLastCalledWith('migrate_legacy_content', {
      kind: 'favourites',
      arrayRaw: '["a","b"]',
      singleRaw: null
    });
    invoke.mockResolvedValueOnce([]);
    await migrateLegacyContent('signatures', null, '{"id":"s"}');
    expect(invoke).toHaveBeenLastCalledWith('migrate_legacy_content', {
      kind: 'signatures',
      arrayRaw: null,
      singleRaw: '{"id":"s"}'
    });
  });

  it('rejects a reply that is not a list of IDs', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue([1]);
    await expect(migrateLegacyContent('favourites', '[]')).rejects.toThrow();
  });
});
