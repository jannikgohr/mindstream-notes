import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { GlobalShortcutStatus } from '$lib/api/hotkeys';

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  isMobile: vi.fn(() => false),
  status: vi.fn<() => Promise<GlobalShortcutStatus>>()
}));
vi.mock('$lib/api/core', () => ({ isTauri: mocks.isTauri }));
vi.mock('$lib/api/hotkeys', () => ({ getGlobalShortcutStatus: mocks.status }));
vi.mock('$lib/platform', () => ({ isMobile: mocks.isMobile }));
import {
  globalShortcutOwnership,
  nativeOwnsGlobalShortcut,
  watchGlobalShortcutOwnership
} from './global-ownership.svelte';

const empty: GlobalShortcutStatus = {
  coordinated: true,
  settling: false,
  registered: [],
  error: null
};
const command = 'global.newMarkdownNote';

beforeEach(() => {
  mocks.isTauri.mockReturnValue(true);
  mocks.isMobile.mockReturnValue(false);
  mocks.status.mockReset();
  mocks.status.mockResolvedValue(empty);
  globalShortcutOwnership.status = null;
  globalShortcutOwnership.error = null;
});
afterEach(() => vi.useRealTimers());

describe('coordinator shortcut ownership', () => {
  it('keeps browser, mobile and unsupported local bindings synchronous', () => {
    mocks.isTauri.mockReturnValue(false);
    expect(nativeOwnsGlobalShortcut(command, 'mod+alt+n')).toBeNull();
    mocks.isTauri.mockReturnValue(true);
    mocks.isMobile.mockReturnValue(true);
    expect(nativeOwnsGlobalShortcut(command, 'mod+alt+n')).toBeNull();
    mocks.isMobile.mockReturnValue(false);
    expect(nativeOwnsGlobalShortcut(command, 'mod+alt+ö')).toBeNull();
    expect(mocks.status).not.toHaveBeenCalled();
  });
  it('queries current root ownership even when this vault disabled shortcuts', async () => {
    mocks.status.mockResolvedValue({
      ...empty,
      registered: [
        { commandId: command, accelerator: 'CommandOrControl+Alt+KeyN' }
      ]
    });
    expect(await nativeOwnsGlobalShortcut(command, 'mod+alt+n')).toBe(true);
    expect(mocks.status).toHaveBeenCalledOnce();
  });
  it('leaves unregistered and newly changed bindings available locally', async () => {
    expect(await nativeOwnsGlobalShortcut(command, 'mod+alt+n')).toBe(false);
    mocks.status.mockResolvedValue({
      ...empty,
      registered: [
        { commandId: command, accelerator: 'CommandOrControl+Alt+KeyN' }
      ]
    });
    expect(await nativeOwnsGlobalShortcut(command, 'mod+alt+k')).toBe(false);
  });
  it('suppresses local execution while registration is settling or ownership is unknown', async () => {
    mocks.status.mockResolvedValue({ ...empty, settling: true });
    expect(await nativeOwnsGlobalShortcut(command, 'mod+alt+n')).toBe(true);
    mocks.status.mockRejectedValue(new Error('coordinator unavailable'));
    expect(await nativeOwnsGlobalShortcut(command, 'mod+alt+n')).toBe(true);
    expect(globalShortcutOwnership.error).toBe('coordinator unavailable');
  });
  it('retains registration errors without claiming failed bindings are registered', async () => {
    mocks.status.mockResolvedValue({ ...empty, error: 'OS conflict' });
    expect(await nativeOwnsGlobalShortcut(command, 'mod+alt+n')).toBe(false);
    expect(globalShortcutOwnership.error).toBe('OS conflict');
  });
  it('preserves the direct runtime local dispatcher', async () => {
    mocks.status.mockResolvedValue({ ...empty, coordinated: false });
    expect(await nativeOwnsGlobalShortcut(command, 'mod+alt+n')).toBe(false);
  });
  it('polls without overlapping requests and stops after teardown', async () => {
    vi.useFakeTimers();
    let resolve!: (value: GlobalShortcutStatus) => void;
    mocks.status.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const stop = watchGlobalShortcutOwnership();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.status).toHaveBeenCalledOnce();
    resolve(empty);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.status).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.status).toHaveBeenCalledTimes(2);
  });
});
