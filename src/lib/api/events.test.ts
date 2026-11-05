import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emit, listen, TauriEventName } from './events';

const { tauriEmit, tauriListen } = vi.hoisted(() => ({
  tauriEmit: vi.fn(),
  tauriListen: vi.fn()
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: tauriEmit,
  listen: tauriListen
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: 'note_one' })
}));

describe('TauriEventName', () => {
  it('matches Rust AppEvent wire names', () => {
    expect(TauriEventName.CustomWindowDecorationsChanged).toBe(
      'custom-window-decorations-changed'
    );
    expect(TauriEventName.InvitationsChanged).toBe('invitations-changed');
    expect(TauriEventName.InviteLinkOpened).toBe('invite-link-opened');
    expect(TauriEventName.NativeMenuCommand).toBe('native-menu-command');
    expect(TauriEventName.SessionEnded).toBe('session-ended');
    expect(TauriEventName.ShowApp).toBe('show-app');
    expect(TauriEventName.SignaturesChanged).toBe('signatures-changed');
    expect(TauriEventName.SyncCompleted).toBe('sync-completed');
    expect(TauriEventName.SyncUnreachable).toBe('sync-unreachable');
    expect(TauriEventName.TrayNoteCreated).toBe('tray-note-created');
  });
});

describe('Tauri event wrappers', () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    tauriEmit.mockReset();
    tauriListen.mockReset();
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('emits typed event payloads through the enum name', () => {
    emit(TauriEventName.SignaturesChanged, null);

    expect(tauriEmit).toHaveBeenCalledWith('signatures-changed', null);
  });

  it('forwards listener payloads without exposing raw Tauri events', async () => {
    const handler = vi.fn();
    tauriListen.mockImplementation((_event, callback) => {
      callback({ payload: { note_id: 'note_1' } });
      return Promise.resolve(() => undefined);
    });

    await listen(TauriEventName.TrayNoteCreated, handler);

    expect(tauriListen).toHaveBeenCalledWith(
      'tray-note-created',
      expect.any(Function)
    );
    expect(handler).toHaveBeenCalledWith({ note_id: 'note_1' });
  });

  it('limits a listener to events sent to this window when asked', async () => {
    tauriListen.mockResolvedValue(() => undefined);

    await listen(TauriEventName.VaultWorkerClose, vi.fn(), {
      thisWindow: true
    });

    expect(tauriListen).toHaveBeenCalledWith(
      'vault-worker-close',
      expect.any(Function),
      { target: 'note_one' }
    );
  });
});

it('delivers browser events and unsubscribes without native IPC', async () => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  const handler = vi.fn();
  const unlisten = await listen(TauriEventName.TrayNoteCreated, handler);
  await emit(TauriEventName.TrayNoteCreated, { note_id: 'persisted' });
  expect(handler).toHaveBeenCalledWith({ note_id: 'persisted' });
  unlisten();
  await emit(TauriEventName.TrayNoteCreated, { note_id: 'later' });
  expect(handler).toHaveBeenCalledTimes(1);
});
