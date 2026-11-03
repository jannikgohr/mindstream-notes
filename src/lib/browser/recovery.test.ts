import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkpointBrowserNote,
  captureBrowserAcknowledgement,
  recoverBrowserNotes,
  rememberBrowserNote,
  beginBrowserWrite
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
      },
      recoveryToken: expect.any(String)
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

  it('recovers newer typing when an issued save committed before its acknowledgement', async () => {
    const first = { ...original, body: 'first' };
    checkpointBrowserNote(() => first);
    const acknowledge = captureBrowserAcknowledgement('note');
    const write = beginBrowserWrite('note', acknowledge.token);
    checkpointBrowserNote(() => ({ ...original, body: 'second' }));
    // A reload loses the in-memory acknowledgement; only the journal and DB remain.
    write.finish();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...first, yrs_state: [99] })
      .mockResolvedValueOnce(write.token)
      .mockResolvedValueOnce({ ...first, body: 'second' });
    await recoverBrowserNotes(connection(request));
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1]).toEqual(['receipt', { id: 'note' }]);
    expect(request.mock.calls[2][1].args.input.body).toBe('second');
    expect(recoveryStatus.copies).toHaveLength(0);
  });

  it('an issued write does not authorize overwriting unrelated saved content', async () => {
    const first = { ...original, body: 'first' };
    checkpointBrowserNote(() => first);
    const acknowledge = captureBrowserAcknowledgement('note');
    const write = beginBrowserWrite('note', acknowledge.token);
    checkpointBrowserNote(() => ({ ...original, body: 'second' }));
    write.finish();
    const request = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(null);
    await recoverBrowserNotes(connection(request));
    expect(request).toHaveBeenCalledTimes(2);
    expect(recoveryStatus.copies[0].reason).toBe('conflict');
  });

  it('rebases edits during an explicit save even if no checkpoint existed at capture', async () => {
    const acknowledge = captureBrowserAcknowledgement('note');
    checkpointBrowserNote(() => ({ ...original, body: 'second' }));
    const first = { ...original, body: 'first' };
    rememberBrowserNote(first);
    acknowledge();
    const request = requestWith(first);
    await recoverBrowserNotes(connection(request));
    expect(request).toHaveBeenCalledTimes(2);
    expect(recoveryStatus.copies).toHaveLength(0);
  });

  it('keeps a second editor save token when the first save acknowledges', async () => {
    checkpointBrowserNote(() => ({ ...original, body: 'first snapshot' }));
    const acknowledgeA = captureBrowserAcknowledgement('note');
    const writeA = beginBrowserWrite('note', acknowledgeA.token);
    checkpointBrowserNote(() => ({ ...original, body: 'newer snapshot' }));
    const acknowledgeB = captureBrowserAcknowledgement('note');
    const writeB = beginBrowserWrite('note', acknowledgeB.token);
    rememberBrowserNote({ ...original, body: 'saved A' });
    writeA.finish();
    acknowledgeA();
    checkpointBrowserNote(() => ({ ...original, body: 'newest typing' }));
    writeB.finish();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...original, body: 'saved B' })
      .mockResolvedValueOnce(writeB.token)
      .mockResolvedValueOnce({ ...original, body: 'newest typing' });
    await recoverBrowserNotes(connection(request));
    expect(request.mock.calls[2][1].args.input.body).toBe('newest typing');
    expect(recoveryStatus.copies).toHaveLength(0);
  });

  it('does not authorize receipts for independent or unknown-token writes', () => {
    expect(beginBrowserWrite('note').token).toBeUndefined();
    expect(beginBrowserWrite('note', 'unissued-token').token).toBeUndefined();
    const acknowledge = captureBrowserAcknowledgement('note');
    expect(
      beginBrowserWrite('different-note', acknowledge.token).token
    ).toBeUndefined();
    acknowledge();
  });

  it('clears an acknowledged snapshot when only its issued-write bookkeeping changed', () => {
    const first = { ...original, body: 'first' };
    checkpointBrowserNote(() => first);
    const acknowledge = captureBrowserAcknowledgement('note');
    const write = beginBrowserWrite('note', acknowledge.token);
    rememberBrowserNote(first);
    acknowledge();
    write.finish();
    expect(raw()).toBeNull();
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
    const retained = recoveryStatus.copies[0];
    expect(retained).toMatchObject({ reason: 'refused' });
    expect(retained.key).not.toBe(prefix + 'note');
    expect(JSON.parse(retained.raw)).toMatchObject({
      id: 'note',
      body: JSON.parse(savedRaw!).body
    });
    expect(Object.values(localStorage)).toContain(retained.raw);
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
    expect(() =>
      checkpointBrowserNote(() => ({ id: 'note', body: 'new typing' }))
    ).toThrow('must be preserved');
    expect(raw()).toBe(savedRaw);
    const acknowledge = captureBrowserAcknowledgement('note');
    rememberBrowserNote({ ...original, body: 'new typing saved to SQLite' });
    acknowledge();
    expect(raw()).toBe(savedRaw);
    await recoverBrowserNotes(
      connection(requestWith({ ...original, body: 'newer' }))
    );
    expect(recoveryStatus.copies).toHaveLength(1);
    expect(recoveryStatus.copies[0].key).toBe(prefix + 'note');
  });

  it('does not overwrite a checkpoint written while load_note is pending', async () => {
    checkpointBrowserNote(() => ({ id: 'note', body: 'old edit' }));
    let loaded!: (note: typeof original) => void;
    const pendingLoad = new Promise<typeof original>(
      (resolve) => (loaded = resolve)
    );
    const request = vi.fn().mockReturnValueOnce(pendingLoad);
    const recovering = recoverBrowserNotes(connection(request));
    checkpointBrowserNote(() => ({ id: 'note', body: 'new typing' }));
    loaded(original);
    await recovering;
    expect(JSON.parse(raw()!).body).toBe('new typing');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('records an archived recovery copy once across repeated recovery passes', async () => {
    checkpointBrowserNote(() => ({ id: 'note', body: 'pending' }));
    const request = vi
      .fn()
      .mockResolvedValue({ ...original, body: 'other edit' });
    await recoverBrowserNotes(connection(request));
    const copies = recoveryStatus.copies.length;
    await recoverBrowserNotes(connection(request));
    expect(copies).toBe(1);
    expect(recoveryStatus.copies).toHaveLength(1);
    expect(recoveryStatus.copies[0].key).not.toBe(prefix + 'note');
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
