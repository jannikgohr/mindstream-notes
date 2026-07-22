import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listen, handlers, isTauri, loadTree } = vi.hoisted(() => ({
  handlers: {} as Record<string, (p: unknown) => void>,
  listen: vi.fn(
    (event: string, handler: (p: unknown) => void) =>
      new Promise<() => void>((resolve) => {
        (handlers as Record<string, (p: unknown) => void>)[event] = handler;
        resolve(() => delete handlers[event]);
      })
  ),
  isTauri: vi.fn(() => false),
  loadTree: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('$lib/api/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/api/core')>();
  return { ...actual, isTauri };
});
vi.mock('$lib/api/events', () => ({
  listen,
  TauriEventName: {
    SyncCompleted: 'sync-completed'
  }
}));
vi.mock('$lib/stores/tree.svelte', () => ({ loadTree }));

import { installSyncTreeRefreshBridge } from './tree-refresh-bridge';

beforeEach(() => {
  for (const key of Object.keys(handlers)) delete handlers[key];
  listen.mockClear();
  loadTree.mockClear();
  isTauri.mockReturnValue(true);
});

describe('installSyncTreeRefreshBridge', () => {
  it('reloads the tree when a scheduled sync completes', () => {
    installSyncTreeRefreshBridge();
    expect(loadTree).not.toHaveBeenCalled();

    handlers['sync-completed']?.({
      report: {},
      notes_pulled_ids: ['note_1'],
      assets_pulled_ids: []
    });

    expect(loadTree).toHaveBeenCalledTimes(1);
  });

  it('reloads even when the sync pulled nothing (timestamps still move)', () => {
    installSyncTreeRefreshBridge();
    handlers['sync-completed']?.({
      report: {},
      notes_pulled_ids: [],
      assets_pulled_ids: []
    });
    expect(loadTree).toHaveBeenCalledTimes(1);
  });

  it('is a no-op outside Tauri', () => {
    isTauri.mockReturnValue(false);
    const teardown = installSyncTreeRefreshBridge();
    expect(listen).not.toHaveBeenCalled();
    teardown();
  });

  it('stops refreshing after teardown', async () => {
    const teardown = installSyncTreeRefreshBridge();
    teardown();
    await Promise.resolve();
    expect(handlers['sync-completed']).toBeUndefined();
  });
});
