import { beforeEach, describe, expect, it, vi } from 'vitest';

// The bridge pulls tUi (i18n), syncNow (Tauri invoke), isTauri and the
// event listener. Mock all four so the wiring is exercised in isolation;
// the notification store itself is used for real (it's dependency-light).
const { listen, handlers, syncNow, isTauri } = vi.hoisted(() => ({
  handlers: {} as Record<string, (p: unknown) => void>,
  listen: vi.fn(
    (event: string, handler: (p: unknown) => void) =>
      new Promise<() => void>((resolve) => {
        (handlers as Record<string, (p: unknown) => void>)[event] = handler;
        resolve(() => delete handlers[event]);
      })
  ),
  syncNow: vi.fn().mockResolvedValue(undefined),
  // Default false so the settings store's import-time hydration takes the
  // non-Tauri fallback path instead of attempting real invokes. Tests
  // that exercise the bridge flip it true explicitly.
  isTauri: vi.fn(() => false)
}));

// Preserve the rest of api/core (invokeOrFallback et al.) — the store's
// import-time settings hydration reaches for it — and only stub isTauri.
vi.mock('$lib/api/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/api/core')>();
  return { ...actual, isTauri };
});
vi.mock('$lib/api/events', () => ({ listen }));
vi.mock('$lib/api/sync', () => ({ syncNow }));
// tUi is left real: it resolves synchronously from the bundled en.json,
// so the offline message keeps its `{server}` placeholder for us to assert
// on — and the real module still provides `setLanguage`, which the
// settings store's import-time hydration reaches for.

import { notificationState } from './store.svelte';
import {
  clearServerUnreachable,
  installSyncStatusBridge,
  reportServerUnreachable
} from './sync-status';

beforeEach(() => {
  notificationState.items = [];
  for (const key of Object.keys(handlers)) delete handlers[key];
  listen.mockClear();
  syncNow.mockClear();
  isTauri.mockReturnValue(false);
});

describe('reportServerUnreachable', () => {
  it('surfaces one sync-offline notification with the server in the message', () => {
    reportServerUnreachable('https://etebase.example.ts.net/');
    expect(notificationState.items).toHaveLength(1);
    const n = notificationState.items[0];
    expect(n.kind).toBe('sync-offline');
    expect(n.widgetType).toBe('generic');
    expect((n.data as { message: string }).message).toContain(
      'https://etebase.example.ts.net/'
    );
  });

  it('refreshes in place instead of stacking on repeated failures', () => {
    reportServerUnreachable('https://a/');
    reportServerUnreachable('https://b/');
    expect(notificationState.items).toHaveLength(1);
    expect(
      (notificationState.items[0].data as { message: string }).message
    ).toContain('https://b/');
  });

  it('retries a manual sync when opened', async () => {
    reportServerUnreachable('https://a/');
    await notificationState.items[0].onOpen?.();
    expect(syncNow).toHaveBeenCalledOnce();
  });

  it('swallows a failed retry so opening never throws', async () => {
    syncNow.mockRejectedValueOnce(new Error('still offline'));
    reportServerUnreachable('https://a/');
    await expect(
      notificationState.items[0].onOpen?.()
    ).resolves.toBeUndefined();
  });
});

describe('clearServerUnreachable', () => {
  it('drops the offline notification but leaves others', () => {
    reportServerUnreachable('https://a/');
    notificationState.items.push({
      id: 'other',
      kind: 'generic',
      widgetType: 'generic',
      createdAt: Date.now(),
      data: {}
    });
    clearServerUnreachable();
    expect(notificationState.items.map((n) => n.id)).toEqual(['other']);
  });
});

describe('installSyncStatusBridge', () => {
  it('wires unreachable→report and completed→clear, and tears down', async () => {
    isTauri.mockReturnValue(true);
    const teardown = installSyncStatusBridge();
    expect(listen).toHaveBeenCalledTimes(2);
    // Let the listen promises resolve so the handlers register.
    await Promise.resolve();

    handlers['sync-unreachable']?.({ server_url: 'https://a/', detail: 'dns' });
    expect(notificationState.items).toHaveLength(1);
    expect(notificationState.items[0].kind).toBe('sync-offline');

    handlers['sync-completed']?.({});
    expect(notificationState.items).toHaveLength(0);

    teardown();
  });

  it('is a no-op outside Tauri', () => {
    isTauri.mockReturnValue(false);
    const teardown = installSyncStatusBridge();
    expect(listen).not.toHaveBeenCalled();
    expect(teardown).toBeTypeOf('function');
  });
});
