import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  isMobile: vi.fn(() => false),
  flushBeforeAppClose: vi.fn(async () => {}),
  flushSettingsWrites: vi.fn(async () => {}),
  pushToast: vi.fn(),
  freezeCloseInput: vi.fn()
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args)
}));
vi.mock('$lib/api/events', async (orig) => {
  const actual = await orig<typeof import('$lib/api/events')>();
  return { ...actual, listen: mocks.listen };
});
vi.mock('$lib/platform', async (orig) => {
  const actual = await orig<typeof import('$lib/platform')>();
  return { ...actual, isMobile: mocks.isMobile };
});
vi.mock('$lib/editor/suspend-flush', () => ({
  flushBeforeAppClose: mocks.flushBeforeAppClose
}));
vi.mock('$lib/settings/store.svelte', () => ({
  flushSettingsWrites: mocks.flushSettingsWrites
}));
vi.mock('$lib/settings/i18n.svelte', () => ({ tUi: (key: string) => key }));
vi.mock('$lib/components/toast.svelte', () => ({ pushToast: mocks.pushToast }));
vi.mock('./close-overlay', () => ({
  freezeCloseInput: mocks.freezeCloseInput
}));

import { installWorkerCloseBridge } from './close-bridge';

type Handler = (payload: unknown) => void;

/** Register every event listener and expose its handler and unlisten spy. */
function events() {
  const handlers = new Map<string, Handler>();
  const unlisten = new Map<string, ReturnType<typeof vi.fn>>();
  mocks.listen.mockImplementation((event: string, handler: Handler) => {
    handlers.set(event, handler);
    const stop = vi.fn();
    unlisten.set(event, stop);
    return Promise.resolve(stop);
  });
  return {
    send: (event: string, payload: unknown) => handlers.get(event)?.(payload),
    unlisten
  };
}

function overlay() {
  const current = { restore: vi.fn(), phase: vi.fn() };
  mocks.freezeCloseInput.mockReturnValue(current);
  return current;
}

const NIL = '00000000-0000-0000-0000-000000000000';

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  mocks.invoke.mockImplementation(async (command: string) =>
    command === 'vault_window_close_ready' ? true : null
  );
  mocks.isMobile.mockReturnValue(false);
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('worker close bridge', () => {
  it('stays inert in the browser and on mobile', () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    installWorkerCloseBridge()();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    mocks.isMobile.mockReturnValue(true);
    installWorkerCloseBridge()();
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('declares the window ready only once its close listener exists', async () => {
    const { unlisten } = events();
    const stop = installWorkerCloseBridge();
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('vault_window_close_ready', {
        protocol: 2
      })
    );
    expect(mocks.listen).toHaveBeenCalledWith(
      'vault-worker-close',
      expect.any(Function)
    );
    stop();
    await vi.waitFor(() =>
      expect(unlisten.get('vault-worker-close')).toHaveBeenCalled()
    );
    expect(unlisten.get('capture-failed')).toHaveBeenCalled();
    expect(unlisten.get('environment-quit-failed')).toHaveBeenCalled();
  });

  it('never declares readiness when stopped before the listener registers', async () => {
    const stopClose = vi.fn();
    let register: (stop: () => void) => void = () => {};
    mocks.listen.mockImplementation((event: string) =>
      event === 'vault-worker-close'
        ? new Promise((resolve) => {
            register = resolve;
          })
        : Promise.resolve(vi.fn())
    );
    installWorkerCloseBridge()();
    register(stopClose);
    await vi.waitFor(() => expect(stopClose).toHaveBeenCalled());
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('freezes input, flushes every writer and acknowledges the saved close', async () => {
    const { send } = events();
    const frozen = overlay();
    const stop = installWorkerCloseBridge();
    send('vault-worker-close', { id: 'close', phase: 'waiting' });
    expect(mocks.freezeCloseInput).toHaveBeenCalledTimes(1);
    expect(frozen.phase).toHaveBeenCalledWith('waiting');
    send('vault-worker-close', { id: 'close', phase: 'prepare' });
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('vault_window_close_ack', {
        id: 'close',
        saved: true
      })
    );
    expect(frozen.phase).toHaveBeenLastCalledWith('prepare');
    expect(mocks.flushBeforeAppClose).toHaveBeenCalledTimes(1);
    expect(mocks.flushSettingsWrites).toHaveBeenCalledTimes(1);
    stop();
    expect(frozen.restore).toHaveBeenCalledTimes(1);
  });

  it('still flushes settings and reports an unsaved close when the editor flush fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send } = events();
    overlay();
    mocks.flushBeforeAppClose.mockRejectedValueOnce(new Error('disk full'));
    installWorkerCloseBridge();
    send('vault-worker-close', { id: 'close', phase: 'prepare' });
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('vault_window_close_ack', {
        id: 'close',
        saved: false
      })
    );
    expect(mocks.flushSettingsWrites).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[vaults] close persistence failed',
      expect.any(Error)
    );
  });

  it('unfreezes on cancellation and explains why the vault stayed open', async () => {
    const { send } = events();
    const first = overlay();
    installWorkerCloseBridge();
    send('vault-worker-close', { id: 'switch', phase: 'waiting' });
    send('vault-worker-close', {
      id: 'switch',
      phase: 'cancel',
      reason: 'recovery'
    });
    expect(first.restore).toHaveBeenCalledTimes(1);
    expect(mocks.pushToast).toHaveBeenLastCalledWith('vault.switchCancelled', {
      variant: 'info',
      durationMs: 6000
    });
    send('vault-worker-close', {
      id: NIL,
      phase: 'cancel',
      reason: 'background'
    });
    expect(mocks.pushToast).toHaveBeenLastCalledWith('vault.backgroundBusy', {
      variant: 'error',
      durationMs: 0
    });
    send('vault-worker-close', { id: NIL, phase: 'cancel' });
    expect(mocks.pushToast).toHaveBeenLastCalledWith('vault.closeFailed', {
      variant: 'error',
      durationMs: 0
    });
  });

  it('replaces the overlay of a superseded close', () => {
    const { send } = events();
    const first = overlay();
    installWorkerCloseBridge();
    send('vault-worker-close', { id: 'first', phase: 'waiting' });
    const second = overlay();
    send('vault-worker-close', { id: 'second', phase: 'waiting' });
    expect(first.restore).toHaveBeenCalledTimes(1);
    expect(second.phase).toHaveBeenCalledWith('waiting');
    expect(first.phase).toHaveBeenCalledTimes(1);
  });

  it('shows capture and quit failures from the coordinator', () => {
    const { send } = events();
    installWorkerCloseBridge();
    send('capture-failed', { message: 'Vault is locked' });
    expect(mocks.pushToast).toHaveBeenLastCalledWith('Vault is locked', {
      variant: 'error',
      durationMs: 0
    });
    send('environment-quit-failed', { message: 'Saving failed.' });
    expect(mocks.pushToast).toHaveBeenLastCalledWith(
      'vault.closeFailed Saving failed.',
      { variant: 'error', durationMs: 0 }
    );
  });

  it('warns about every listener that cannot be registered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.listen.mockRejectedValue(new Error('no event bus'));
    const stop = installWorkerCloseBridge();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(3));
    expect(warn.mock.calls.map(([message]) => message).sort()).toEqual([
      '[vaults] capture listener unavailable',
      '[vaults] close listener unavailable',
      '[vaults] quit listener unavailable'
    ]);
    stop();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
