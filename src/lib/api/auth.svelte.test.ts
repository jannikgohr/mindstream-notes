import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const flushPendingEditorSaves = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args)
}));

vi.mock('$lib/editor/suspend-flush', () => ({
  flushPendingEditorSaves: () => flushPendingEditorSaves()
}));

const { etebaseLogin, etebaseLogout } = await import('./auth.svelte');

function setTauri(on: boolean): void {
  if (on) {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  } else {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  }
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  setTauri(true);
  invoke.mockReset();
  flushPendingEditorSaves.mockReset();
});

afterEach(() => {
  setTauri(false);
  vi.restoreAllMocks();
});

describe('auth session policy reload', () => {
  it('flushes pending saves before login and reloads after the session changes', async () => {
    const flush = deferred();
    flushPendingEditorSaves.mockReturnValueOnce(flush.promise);
    invoke.mockResolvedValueOnce({
      username: 'alice',
      server_url: 'https://notes.example.test/base'
    });
    const reload = vi
      .spyOn(window.location, 'reload')
      .mockImplementation(() => undefined);

    const login = etebaseLogin({
      serverType: 'self-hosted',
      serverUrl: 'https://notes.example.test/base',
      username: 'alice',
      password: 'secret'
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    flush.resolve();
    await expect(login).resolves.toMatchObject({ username: 'alice' });

    expect(invoke).toHaveBeenCalledWith('etebase_login', {
      args: {
        server_type: 'self-hosted',
        server_url: 'https://notes.example.test/base',
        username: 'alice',
        password: 'secret'
      }
    });
    expect(reload).toHaveBeenCalledOnce();
  });

  it('flushes pending saves before logout and reloads after native logout', async () => {
    const flush = deferred();
    flushPendingEditorSaves.mockReturnValueOnce(flush.promise);
    invoke.mockResolvedValueOnce(undefined);
    const reload = vi
      .spyOn(window.location, 'reload')
      .mockImplementation(() => undefined);

    const logout = etebaseLogout();
    expect(invoke).not.toHaveBeenCalled();
    flush.resolve();
    await logout;

    expect(invoke).toHaveBeenCalledWith('etebase_logout', undefined);
    expect(reload).toHaveBeenCalledOnce();
  });
});
