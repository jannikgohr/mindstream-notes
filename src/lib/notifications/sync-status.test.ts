import { beforeEach, describe, expect, it, vi } from 'vitest';

// The bridge pulls tUi (i18n), syncNow (Tauri invoke), isTauri and the
// event listener. Mock all four so the wiring is exercised in isolation;
// the notification store itself is used for real (it's dependency-light).
const { listen, handlers, syncNow, isTauri, refreshAuthSession } = vi.hoisted(
  () => ({
    refreshAuthSession: vi.fn().mockResolvedValue(undefined),
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
  })
);

// Preserve the rest of api/core (invokeOrFallback et al.) — the store's
// import-time settings hydration reaches for it — and only stub isTauri.
vi.mock('$lib/api/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/api/core')>();
  return { ...actual, isTauri };
});
vi.mock('$lib/api/events', () => ({
  listen,
  TauriEventName: {
    SessionEnded: 'session-ended',
    SyncCompleted: 'sync-completed',
    SyncUnreachable: 'sync-unreachable'
  }
}));
vi.mock('$lib/api/sync', () => ({ syncNow }));
vi.mock('$lib/api/auth.svelte', () => ({ refreshAuthSession }));
// tUi is left real: it resolves synchronously from the bundled en.json,
// so the offline message keeps its `{server}` placeholder for us to assert
// on — and the real module still provides `setLanguage`, which the
// settings store's import-time hydration reaches for.

import de from '$lib/settings/i18n/de.json';
import en from '$lib/settings/i18n/en.json';
import type { SyncLimitReached } from '$lib/api/events';
import { notificationState } from './store.svelte';
import {
  clearServerUnreachable,
  clearSessionEnded,
  clearSyncLimits,
  installSyncStatusBridge,
  reportServerUnreachable,
  reportSessionEnded,
  reportSyncLimits,
  SYNC_LIMIT_UI_KEYS
} from './sync-status';

const VAULT_FULL: SyncLimitReached = {
  reason: 'storage_full',
  folder_id: null,
  folder_name: null,
  owner: null
};
const ADAS_FOLDER_FULL: SyncLimitReached = {
  reason: 'storage_full',
  folder_id: 'root_1',
  folder_name: 'Trip plans',
  owner: 'ada'
};

function texts(): { id: string; title: string; message: string }[] {
  return notificationState.items.map((item) => ({
    id: item.id,
    ...(item.data as { title: string; message: string })
  }));
}

beforeEach(() => {
  notificationState.items = [];
  for (const key of Object.keys(handlers)) delete handlers[key];
  listen.mockClear();
  syncNow.mockClear();
  refreshAuthSession.mockClear();
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

describe('reportSessionEnded', () => {
  it('names the server and says the notes are still there', () => {
    reportSessionEnded('https://notes.example.com/');
    expect(notificationState.items).toHaveLength(1);
    const n = notificationState.items[0];
    expect(n.kind).toBe('session-ended');
    expect(n.widgetType).toBe('generic');
    const { title, message } = n.data as { title: string; message: string };
    expect(title).toBe('Signed out on this device');
    expect(message).toContain('https://notes.example.com/');
    expect(message).toContain('Your notes are still here');
  });

  it('is told once however often the server refuses', () => {
    reportSessionEnded('https://a/');
    reportSessionEnded('https://a/');
    expect(notificationState.items).toHaveLength(1);
  });

  it('leaves other notifications alone when cleared', () => {
    reportSessionEnded('https://a/');
    reportServerUnreachable('https://a/');
    clearSessionEnded();
    expect(notificationState.items.map((n) => n.kind)).toEqual([
      'sync-offline'
    ]);
  });
});

describe('reportSyncLimits', () => {
  it('says the own storage is full, without naming anyone', () => {
    reportSyncLimits([VAULT_FULL]);
    expect(notificationState.items).toHaveLength(1);
    expect(notificationState.items[0].kind).toBe('sync-limit');
    expect(notificationState.items[0].widgetType).toBe('generic');
    const [{ title, message }] = texts();
    expect(title).toBe('Your storage is full');
    expect(message).toContain('stay on this device');
  });

  it('says whose storage is full in a folder someone else shared', () => {
    reportSyncLimits([ADAS_FOLDER_FULL]);
    const [{ title, message }] = texts();
    expect(title).toBe("ada's storage is full");
    expect(message).toContain('“Trip plans”');
    expect(message).toContain('once ada has made room');
    expect(message).not.toMatch(/\{\w+\}/);
  });

  it('has a sentence for a lapsed plan and for something too large', () => {
    reportSyncLimits([
      { ...VAULT_FULL, reason: 'plan_lapsed' },
      { ...ADAS_FOLDER_FULL, reason: 'item_too_large' }
    ]);
    const shown = texts();
    expect(shown.map((n) => n.title).sort()).toEqual([
      'Something is too large for “Trip plans”',
      'Your plan has ended'
    ]);
    expect(shown.every((n) => !/\{\w+\}/.test(n.message))).toBe(true);
  });

  it('still says something for a limit it has no sentence for', () => {
    reportSyncLimits([{ ...ADAS_FOLDER_FULL, reason: 'a_new_limit' }]);
    const [{ title, message }] = texts();
    expect(title).toBe('“Trip plans” is not taking new changes');
    expect(message).toContain("ada's plan");
  });

  it('gives a folder without a name one to go by', () => {
    reportSyncLimits([{ ...ADAS_FOLDER_FULL, folder_name: null }]);
    expect(texts()[0].message).toContain('“Shared folder”');
  });

  it('is one notice for the own plan however many spaces ran into it', () => {
    reportSyncLimits([
      VAULT_FULL,
      { ...VAULT_FULL, folder_id: 'mine', folder_name: 'Shared by me' }
    ]);
    expect(notificationState.items).toHaveLength(1);
  });

  it('is one notice for each folder on the plan of someone else', () => {
    reportSyncLimits([
      ADAS_FOLDER_FULL,
      { ...ADAS_FOLDER_FULL, folder_id: 'root_2', folder_name: 'Recipes' }
    ]);
    expect(notificationState.items).toHaveLength(2);
  });

  it('keeps a notice in place while the limit holds', () => {
    reportSyncLimits([VAULT_FULL]);
    const first = notificationState.items[0];
    reportSyncLimits([VAULT_FULL]);
    expect(notificationState.items).toHaveLength(1);
    expect(notificationState.items[0].id).toBe(first.id);
    expect(notificationState.items[0].createdAt).toBe(first.createdAt);
  });

  it('takes back what no longer holds and leaves the rest', () => {
    reportSyncLimits([VAULT_FULL, ADAS_FOLDER_FULL]);
    reportServerUnreachable('https://a/');
    reportSyncLimits([ADAS_FOLDER_FULL]);
    expect(notificationState.items.map((n) => n.kind).sort()).toEqual([
      'sync-limit',
      'sync-offline'
    ]);
    expect(texts().some((n) => n.title === "ada's storage is full")).toBe(true);

    reportSyncLimits([]);
    expect(notificationState.items.map((n) => n.kind)).toEqual([
      'sync-offline'
    ]);
  });

  it('can be cleared without touching other notices', () => {
    reportSyncLimits([VAULT_FULL]);
    reportServerUnreachable('https://a/');
    clearSyncLimits();
    expect(notificationState.items.map((n) => n.kind)).toEqual([
      'sync-offline'
    ]);
  });

  it('has every sentence in both languages, with the same slots', () => {
    const slots = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const key of SYNC_LIMIT_UI_KEYS) {
      const english = (en.ui as Record<string, string>)[key];
      const german = (de.ui as Record<string, string>)[key];
      expect(english, `en ${key}`).toBeTypeOf('string');
      expect(german, `de ${key}`).toBeTypeOf('string');
      expect(slots(german), key).toEqual(slots(english));
    }
  });
});

describe('installSyncStatusBridge', () => {
  it('shows the limits a sync ran into and clears them when it has room', async () => {
    isTauri.mockReturnValue(true);
    const teardown = installSyncStatusBridge();
    await Promise.resolve();

    handlers['sync-completed']?.({ limits: [ADAS_FOLDER_FULL] });
    expect(notificationState.items.map((n) => n.kind)).toEqual(['sync-limit']);

    // The same limit on the next sync changes nothing.
    handlers['sync-completed']?.({ limits: [ADAS_FOLDER_FULL] });
    expect(notificationState.items).toHaveLength(1);

    handlers['sync-completed']?.({ limits: [] });
    expect(notificationState.items).toHaveLength(0);

    teardown();
  });

  it('drops the limits of an account the device was signed out of', async () => {
    isTauri.mockReturnValue(true);
    const teardown = installSyncStatusBridge();
    await Promise.resolve();

    handlers['sync-completed']?.({ limits: [VAULT_FULL] });
    handlers['session-ended']?.({
      username: 'ann',
      server_url: 'https://notes.example.com/'
    });
    expect(notificationState.items.map((n) => n.kind)).toEqual([
      'session-ended'
    ]);

    teardown();
  });

  it('wires unreachable→report and completed→clear, and tears down', async () => {
    isTauri.mockReturnValue(true);
    const teardown = installSyncStatusBridge();
    expect(listen).toHaveBeenCalledTimes(3);
    // Let the listen promises resolve so the handlers register.
    await Promise.resolve();

    handlers['sync-unreachable']?.({ server_url: 'https://a/', detail: 'dns' });
    expect(notificationState.items).toHaveLength(1);
    expect(notificationState.items[0].kind).toBe('sync-offline');

    handlers['sync-completed']?.({});
    expect(notificationState.items).toHaveLength(0);

    teardown();
  });

  it('reports a session the server ended, and has the UI sign out', async () => {
    isTauri.mockReturnValue(true);
    const teardown = installSyncStatusBridge();
    await Promise.resolve();

    handlers['session-ended']?.({
      username: 'ann',
      server_url: 'https://notes.example.com/'
    });
    expect(notificationState.items).toHaveLength(1);
    expect(notificationState.items[0].kind).toBe('session-ended');
    expect(refreshAuthSession).toHaveBeenCalledOnce();

    // Signing in again and syncing is what clears it.
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
