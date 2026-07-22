import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GlobalShortcutRegistration } from './global.svelte';

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  isMobile: vi.fn(() => false),
  syncNativeGlobalShortcuts: vi.fn<() => Promise<void>>()
}));

vi.mock('$lib/api/core', () => ({
  isTauri: mocks.isTauri
}));

vi.mock('$lib/api/hotkeys', () => ({
  syncNativeGlobalShortcuts: mocks.syncNativeGlobalShortcuts
}));

vi.mock('$lib/platform', () => ({
  isMobile: mocks.isMobile
}));

vi.mock('./catalogue', () => {
  const commands = new Map([
    ['global.valid', { id: 'global.valid', scope: 'global' }],
    ['local.valid', { id: 'local.valid', scope: 'editor' }]
  ]);

  return {
    commandById: (id: string) => commands.get(id) ?? null,
    isGlobalShortcutCommand: (command: { id?: string } | string) =>
      (typeof command === 'string' ? command : command.id) === 'global.valid'
  };
});

async function importGlobalShortcuts() {
  return import('./global.svelte');
}

function registrations(): GlobalShortcutRegistration[] {
  return [
    { commandId: 'global.valid', accelerator: 'Ctrl+Alt+K' },
    { commandId: 'global.valid', accelerator: null },
    { commandId: 'local.valid', accelerator: 'Ctrl+Alt+L' },
    { commandId: 'missing.command', accelerator: 'Ctrl+Alt+M' }
  ];
}

beforeEach(() => {
  vi.resetModules();
  mocks.isTauri.mockReturnValue(true);
  mocks.isMobile.mockReturnValue(false);
  mocks.syncNativeGlobalShortcuts.mockReset();
  mocks.syncNativeGlobalShortcuts.mockResolvedValue(undefined);
});

describe('syncGlobalShortcuts', () => {
  it('does not sync native shortcuts outside Tauri', async () => {
    mocks.isTauri.mockReturnValue(false);
    const { syncGlobalShortcuts } = await importGlobalShortcuts();

    await syncGlobalShortcuts([
      { commandId: 'global.valid', accelerator: 'Ctrl+Alt+K' }
    ]);

    expect(mocks.syncNativeGlobalShortcuts).not.toHaveBeenCalled();
  });

  it('does not sync native shortcuts on mobile', async () => {
    mocks.isMobile.mockReturnValue(true);
    const { syncGlobalShortcuts } = await importGlobalShortcuts();

    await syncGlobalShortcuts([
      { commandId: 'global.valid', accelerator: 'Ctrl+Alt+K' }
    ]);

    expect(mocks.syncNativeGlobalShortcuts).not.toHaveBeenCalled();
  });

  it('syncs only runnable global commands with accelerators', async () => {
    const { syncGlobalShortcuts } = await importGlobalShortcuts();

    await syncGlobalShortcuts(registrations());

    expect(mocks.syncNativeGlobalShortcuts).toHaveBeenCalledWith([
      { commandId: 'global.valid', accelerator: 'Ctrl+Alt+K' }
    ]);
  });

  it('dedupes unchanged registrations by signature', async () => {
    const { syncGlobalShortcuts } = await importGlobalShortcuts();
    const input = [{ commandId: 'global.valid', accelerator: 'Ctrl+Alt+K' }];

    await syncGlobalShortcuts(input);
    await syncGlobalShortcuts(input);

    expect(mocks.syncNativeGlobalShortcuts).toHaveBeenCalledTimes(1);
  });

  it('resets the signature after a failed sync so the next render retries', async () => {
    const error = new Error('bad accelerator');
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    mocks.syncNativeGlobalShortcuts.mockRejectedValueOnce(error);

    const { syncGlobalShortcuts } = await importGlobalShortcuts();
    const input = [{ commandId: 'global.valid', accelerator: 'Ctrl+Alt+K' }];

    await expect(syncGlobalShortcuts(input)).rejects.toThrow(error);
    await syncGlobalShortcuts(input);

    expect(mocks.syncNativeGlobalShortcuts).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith(
      '[hotkeys] syncGlobalShortcuts failed',
      error
    );
    consoleError.mockRestore();
  });
});

describe('teardownGlobalShortcuts', () => {
  it('unregisters native shortcuts and lets the same registrations sync again', async () => {
    const { syncGlobalShortcuts, teardownGlobalShortcuts } =
      await importGlobalShortcuts();
    const input = [{ commandId: 'global.valid', accelerator: 'Ctrl+Alt+K' }];

    await syncGlobalShortcuts(input);
    await teardownGlobalShortcuts();
    await syncGlobalShortcuts(input);

    expect(mocks.syncNativeGlobalShortcuts).toHaveBeenNthCalledWith(1, input);
    expect(mocks.syncNativeGlobalShortcuts).toHaveBeenNthCalledWith(2, []);
    expect(mocks.syncNativeGlobalShortcuts).toHaveBeenNthCalledWith(3, input);
  });
});
