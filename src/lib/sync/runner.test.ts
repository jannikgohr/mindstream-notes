import { beforeEach, describe, expect, it, vi } from 'vitest';

const { syncNow, loadTree } = vi.hoisted(() => ({
  syncNow: vi.fn(),
  loadTree: vi.fn()
}));

vi.mock('$lib/api/sync', () => ({ syncNow }));
vi.mock('$lib/stores/tree.svelte', () => ({ loadTree }));

import { runSync } from './runner';

const report = { pushed: 0, pulled: 0 } as unknown as Awaited<
  ReturnType<typeof runSync>
>;

beforeEach(() => {
  syncNow.mockReset().mockResolvedValue(report);
  loadTree.mockReset().mockResolvedValue(undefined);
});

describe('runSync', () => {
  it('syncs then refreshes the tree and returns the report', async () => {
    const result = await runSync();
    expect(syncNow).toHaveBeenCalledOnce();
    expect(loadTree).toHaveBeenCalledOnce();
    expect(result).toBe(report);
  });

  it('coalesces concurrent callers onto a single round-trip', async () => {
    let resolveSync!: (r: typeof report) => void;
    syncNow.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveSync = res;
        })
    );

    const a = runSync();
    const b = runSync();
    resolveSync(report);
    await Promise.all([a, b]);

    expect(syncNow).toHaveBeenCalledOnce();
    expect(loadTree).toHaveBeenCalledOnce();
  });

  it('clears the inflight guard so a later call runs again', async () => {
    await runSync();
    await runSync();
    expect(syncNow).toHaveBeenCalledTimes(2);
  });

  it('clears the guard even when the sync rejects', async () => {
    syncNow.mockRejectedValueOnce(new Error('offline'));
    await expect(runSync()).rejects.toThrow('offline');
    // Guard released → the next call starts a fresh sync.
    await runSync();
    expect(syncNow).toHaveBeenCalledTimes(2);
  });
});
