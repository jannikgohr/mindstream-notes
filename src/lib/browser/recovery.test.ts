import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkpointBrowserNote,
  captureBrowserAcknowledgement,
  recoverBrowserNotes,
  rememberBrowserNote
} from './recovery';
import { recoveryStatus } from './recovery-status.svelte';
import type { BrowserStorageClient } from './client';

const prefix = 'mindstream:browser-vault:draft:v1:';
const original = {
  id: 'note',
  body: 'original',
  yrs_state: [],
  trashed: false
};
function connection(request: ReturnType<typeof vi.fn>) {
  return { request } as unknown as Pick<BrowserStorageClient, 'request'>;
}
function raw(id = 'note') {
  return localStorage.getItem(prefix + id);
}
function requestWith(note = original) {
  return vi
    .fn()
    .mockResolvedValueOnce(note)
    .mockResolvedValueOnce({ ...note, body: 'recovered' });
}
beforeEach(() => {
  localStorage.clear();
  recoveryStatus.copies = [];
  recoveryStatus.unavailable = false;
  rememberBrowserNote(original);
  vi.stubEnv('MODE', 'development');
  vi.stubEnv('VITE_BROWSER_MOCKS', '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
});

describe('browser pending note recovery', () => {
  it('synchronously checkpoints compact bytes and recovers before deleting the copy', async () => {
    checkpointBrowserNote(() => ({
      id: 'note',
      body: 'Immediate reload',
      yrs_state: [1, 2]
    }));
    expect(JSON.parse(raw()!)).toMatchObject({
      id: 'note',
      body: 'Immediate reload',
      state: 'AQI='
    });
    const request = requestWith();
    await recoverBrowserNotes(connection(request));
    expect(request).toHaveBeenLastCalledWith('invoke', {
      command: 'save_note',
      args: {
        input: { id: 'note', body: 'Immediate reload', yrs_state: [1, 2] }
      }
    });
    expect(raw()).toBeNull();
  });

  it('rebases newer typing onto an acknowledged save without clearing it', async () => {
    checkpointBrowserNote(() => ({ id: 'note', body: 'first' }));
    const acknowledge = captureBrowserAcknowledgement('note');
    checkpointBrowserNote(() => ({ id: 'note', body: 'second' }));
    const saved = { ...original, body: 'first' };
    rememberBrowserNote(saved);
    acknowledge();
    expect(JSON.parse(raw()!).body).toBe('second');
    const request = requestWith(saved);
    await recoverBrowserNotes(connection(request));
    expect(request.mock.calls[1][1].args.input.body).toBe('second');
    expect(recoveryStatus.copies).toHaveLength(0);
  });

  it('clears only the checkpoint acknowledged by this save', () => {
    checkpointBrowserNote(() => ({ id: 'note', body: 'first' }));
    captureBrowserAcknowledgement('note')();
    expect(raw()).toBeNull();
  });

  it('quarantines refused or failed replays while opening the rest of the vault', async () => {
    checkpointBrowserNote(() => ({ id: 'note', body: 'keep me' }));
    const savedRaw = raw();
    const request = vi
      .fn()
      .mockResolvedValueOnce(original)
      .mockRejectedValueOnce({ code: 'refused', reason: 'readOnly' });
    await recoverBrowserNotes(connection(request));
    expect(recoveryStatus.copies).toEqual([
      { key: prefix + 'note', raw: savedRaw, reason: 'refused' }
    ]);
    expect(Object.values(localStorage)).toContain(savedRaw);
    expect(raw()).toBeNull();
  });

  it('does not overwrite a later independently saved edit', async () => {
    checkpointBrowserNote(() => ({ id: 'note', body: 'old unsaved edit' }));
    const request = requestWith({ ...original, body: 'newer history restore' });
    await recoverBrowserNotes(connection(request));
    expect(request).toHaveBeenCalledTimes(1);
    expect(recoveryStatus.copies[0].reason).toBe('conflict');
  });

  it('accepts metadata changes because the base tracks content', async () => {
    checkpointBrowserNote(() => ({ id: 'note', body: 'pending' }));
    const request = requestWith({
      ...original,
      favourite: true
    } as typeof original);
    await recoverBrowserNotes(connection(request));
    expect(request).toHaveBeenCalledTimes(2);
    expect(recoveryStatus.copies).toHaveLength(0);
  });

  it('clears an already committed snapshot without rewriting it', async () => {
    checkpointBrowserNote(() => ({ id: 'note', body: 'already committed' }));
    const request = requestWith({ ...original, body: 'already committed' });
    await recoverBrowserNotes(connection(request));
    expect(request).toHaveBeenCalledTimes(1);
    expect(raw()).toBeNull();
    expect(recoveryStatus.copies).toHaveLength(0);
  });

  it('preserves drafts for deleted and trashed notes without recreating or editing them', async () => {
    for (const id of ['purged', 'trashed']) {
      rememberBrowserNote({ ...original, id });
      checkpointBrowserNote(() => ({ id, body: 'last edit' }));
    }
    const request = vi
      .fn()
      .mockRejectedValueOnce({ code: 'notFound' })
      .mockResolvedValueOnce({ ...original, id: 'trashed', trashed: true });
    await recoverBrowserNotes(connection(request));
    expect(request).toHaveBeenCalledTimes(2);
    expect(recoveryStatus.copies.map((copy) => copy.reason)).toEqual([
      'deleted',
      'trashed'
    ]);
  });

  it.each([
    '{bad json',
    '{"id":"different","body":"text"}',
    '{"id":"note","base":"x","state":"%%%"}'
  ])('quarantines corrupt data and continues opening: %s', async (value) => {
    localStorage.setItem(prefix + 'note', value);
    const request = vi.fn();
    await recoverBrowserNotes(connection(request));
    expect(recoveryStatus.copies[0].raw).toBe(value);
    expect(request).not.toHaveBeenCalled();
    expect(raw()).toBeNull();
  });

  it('still opens when storage is blocked, without preventing SQLite saves', async () => {
    vi.stubGlobal(
      'localStorage',
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('blocked');
          },
          get() {
            throw new Error('blocked');
          }
        }
      )
    );
    await recoverBrowserNotes(connection(vi.fn()));
    expect(recoveryStatus.unavailable).toBe(true);
    expect(() => captureBrowserAcknowledgement('note')()).not.toThrow();
  });

  it('keeps the original copy and notice if quarantine exceeds quota', async () => {
    checkpointBrowserNote(() => ({ id: 'note', body: 'pending' }));
    const savedRaw = raw();
    const store = localStorage;
    vi.stubGlobal('localStorage', {
      getItem: store.getItem.bind(store),
      setItem() {
        throw new Error('quota');
      },
      [prefix + 'note']: savedRaw
    });
    await recoverBrowserNotes(
      connection(requestWith({ ...original, body: 'newer' }))
    );
    expect(raw()).toBe(savedRaw);
    expect(recoveryStatus.copies[0].raw).toBe(savedRaw);
  });

  it('reports checkpoint quota errors while still allowing SQLite saves', () => {
    vi.stubGlobal('localStorage', {
      setItem() {
        throw new Error('quota');
      },
      getItem: () => null
    });
    expect(() =>
      checkpointBrowserNote(() => ({ id: 'note', body: 'large' }))
    ).toThrow('quota');
    expect(recoveryStatus.unavailable).toBe(true);
    expect(() => captureBrowserAcknowledgement('note')()).not.toThrow();
  });

  it('propagates dead-worker failures so the next call can reconnect', async () => {
    checkpointBrowserNote(() => ({ id: 'note', body: 'pending' }));
    const request = vi
      .fn()
      .mockRejectedValue({ code: 'worker', message: 'crash' });
    await expect(
      recoverBrowserNotes(connection(request))
    ).rejects.toMatchObject({ code: 'worker' });
    expect(raw()).not.toBeNull();
    expect(recoveryStatus.copies).toHaveLength(0);
  });

  it('does not serialize native state or mock fixture state', () => {
    const snapshot = vi.fn(() => ({ id: 'note', body: 'native' }));
    (
      window as unknown as { __TAURI_INTERNALS__?: unknown }
    ).__TAURI_INTERNALS__ = {};
    checkpointBrowserNote(snapshot);
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__;
    vi.stubEnv('VITE_BROWSER_MOCKS', '1');
    checkpointBrowserNote(snapshot);
    expect(snapshot).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
});
