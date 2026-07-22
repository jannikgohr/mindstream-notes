import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emit, listen, TauriEventName } from './events';

const { tauriEmit, tauriListen } = vi.hoisted(() => ({
  tauriEmit: vi.fn(),
  tauriListen: vi.fn()
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: tauriEmit,
  listen: tauriListen
}));

describe('TauriEventName', () => {
  it('matches Rust AppEvent wire names', () => {
    expect(TauriEventName.CollabCredentialsChanged).toBe(
      'collab-credentials-changed'
    );
    expect(TauriEventName.CustomWindowDecorationsChanged).toBe(
      'custom-window-decorations-changed'
    );
    expect(TauriEventName.NativeMenuCommand).toBe('native-menu-command');
    expect(TauriEventName.ShowApp).toBe('show-app');
    expect(TauriEventName.SignaturesChanged).toBe('signatures-changed');
    expect(TauriEventName.SyncCompleted).toBe('sync-completed');
    expect(TauriEventName.SyncUnreachable).toBe('sync-unreachable');
    expect(TauriEventName.TrayNoteCreated).toBe('tray-note-created');
  });
});

describe('Tauri event wrappers', () => {
  beforeEach(() => {
    tauriEmit.mockReset();
    tauriListen.mockReset();
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
});
