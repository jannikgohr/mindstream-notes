import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  native: true,
  android: false,
  mobile: false,
  restartApp: vi.fn(),
  relaunch: vi.fn()
}));
vi.mock('$lib/api', () => ({
  isTauri: () => mocks.native,
  restartApp: mocks.restartApp
}));
vi.mock('$lib/platform', () => ({
  isAndroid: () => mocks.android,
  isMobile: () => mocks.mobile
}));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mocks.relaunch }));
import { restartToApply } from './app-restart';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.native = true;
  mocks.android = mocks.mobile = false;
  mocks.restartApp.mockResolvedValue(undefined);
  mocks.relaunch.mockResolvedValue(undefined);
});

describe('restartToApply', () => {
  it('uses the native bridge on Android, never the desktop plugin', async () => {
    mocks.android = mocks.mobile = true;
    await expect(restartToApply()).resolves.toBe(true);
    expect(mocks.restartApp).toHaveBeenCalledOnce();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it('relaunches through the process plugin on desktop', async () => {
    await expect(restartToApply()).resolves.toBe(true);
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(mocks.restartApp).not.toHaveBeenCalled();
  });

  it('reports false on iOS, which has no restart path', async () => {
    mocks.mobile = true;
    await expect(restartToApply()).resolves.toBe(false);
    expect(mocks.restartApp).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it('reports false in a browser', async () => {
    mocks.native = false;
    await expect(restartToApply()).resolves.toBe(false);
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it.each([
    ['Android', true, mocks.restartApp],
    ['desktop', false, mocks.relaunch]
  ])('reports false when the %s restart rejects', async (_, android, call) => {
    mocks.android = mocks.mobile = android;
    call.mockRejectedValue(new Error('process.restart not allowed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(restartToApply()).resolves.toBe(false);
  });
});
