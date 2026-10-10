import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collabAuthForRoom,
  getOrCreateCollabSigningMaterial,
  type CollabSigningMaterial
} from './collab-signing-key';
import type { RoomInfo } from '$lib/api/sync';
import type { SessionInfo } from '$lib/api/auth.svelte';

// The signing key is derived from the live Etebase session, which only exists
// inside Tauri. Stand in for it so the storage logic can be exercised: the
// store's `current` is the hot path, `etebaseSession()` the lazy fallback.
const api = vi.hoisted(() => ({
  authSession: { current: null as SessionInfo | null },
  etebaseSession: vi.fn(async (): Promise<SessionInfo | null> => null)
}));
vi.mock('$lib/api', () => api);

const native = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  get: vi.fn(),
  store: vi.fn()
}));
vi.mock('$lib/api/core', async (original) => ({
  ...(await original<typeof import('$lib/api/core')>()),
  isTauri: native.isTauri
}));
vi.mock('$lib/api/signing-credentials', () => ({
  getVaultCollabSigningMaterial: native.get,
  storeVaultCollabSigningMaterial: native.store
}));

function session(
  username: string,
  server_url = 'https://etebase.example/'
): SessionInfo {
  return { username, server_url };
}

function room(
  authorized: Array<{ username: string; publicKeyB64: string }>
): RoomInfo {
  return {
    room_id: 'room_1',
    key_b64: 'key',
    collab_epoch: 3,
    writer_auth: {
      authorized_writers: authorized.map((writer) => ({
        username: writer.username,
        public_key_b64: writer.publicKeyB64
      }))
    }
  };
}

describe('collabAuthForRoom', () => {
  it('includes the private signing key only when the local public key is authorized', () => {
    const material: CollabSigningMaterial = {
      username: 'alice',
      publicKeyB64: 'writer',
      privateKeyPkcs8B64: 'private'
    };

    const auth = collabAuthForRoom(
      room([{ username: 'alice', publicKeyB64: 'writer' }]),
      material
    );

    expect(auth?.authorUsername).toBe('alice');
    expect(auth?.authorPublicKeyB64).toBe('writer');
    expect(auth?.authorPrivateKeyPkcs8B64).toBe('private');
  });

  it('returns verify-only auth for view-only members', () => {
    const material: CollabSigningMaterial = {
      username: 'viewer',
      publicKeyB64: 'viewer',
      privateKeyPkcs8B64: 'private'
    };

    const auth = collabAuthForRoom(
      room([{ username: 'writer', publicKeyB64: 'writer-key' }]),
      material
    );

    expect(auth?.authorizedWriters).toEqual([
      { username: 'writer', publicKeyB64: 'writer-key' }
    ]);
    expect(auth?.authorPublicKeyB64).toBeUndefined();
    expect(auth?.authorPrivateKeyPkcs8B64).toBeUndefined();
  });

  it('does not grant signing for a key authorized under a different username', () => {
    const material: CollabSigningMaterial = {
      username: 'viewer',
      publicKeyB64: 'shared-key',
      privateKeyPkcs8B64: 'private'
    };

    const auth = collabAuthForRoom(
      room([{ username: 'writer', publicKeyB64: 'shared-key' }]),
      material
    );

    expect(auth?.authorUsername).toBeUndefined();
    expect(auth?.authorPublicKeyB64).toBeUndefined();
  });

  it('keeps legacy unscoped rooms unsigned', () => {
    const auth = collabAuthForRoom(
      { room_id: 'legacy', key_b64: 'key', collab_epoch: 0 },
      null
    );

    expect(auth).toBeUndefined();
  });
});

describe('getOrCreateCollabSigningMaterial', () => {
  beforeEach(() => {
    window.localStorage.clear();
    api.authSession.current = null;
    api.etebaseSession.mockReset();
    api.etebaseSession.mockResolvedValue(null);
    native.isTauri.mockReturnValue(false);
    native.get.mockReset().mockResolvedValue(null);
    native.store
      .mockReset()
      .mockImplementation(async (_server, material) => material);
  });

  it('has no material while signed out', async () => {
    expect(await getOrCreateCollabSigningMaterial()).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it('falls back to the on-disk session when the store is cold', async () => {
    api.etebaseSession.mockResolvedValue(session('alice'));

    const material = await getOrCreateCollabSigningMaterial();

    expect(material?.username).toBe('alice');
    expect(api.etebaseSession).toHaveBeenCalledOnce();
  });

  it('generates once and reuses the stored key pair', async () => {
    api.authSession.current = session('alice');

    const first = await getOrCreateCollabSigningMaterial();
    const second = await getOrCreateCollabSigningMaterial();

    expect(first?.publicKeyB64).toBeTruthy();
    expect(second).toEqual(first);
    expect(window.localStorage.length).toBe(1);
  });

  it('keys the material per account so two users never share a key', async () => {
    api.authSession.current = session('alice');
    const alice = await getOrCreateCollabSigningMaterial();

    api.authSession.current = session('bob');
    const bob = await getOrCreateCollabSigningMaterial();

    expect(bob?.publicKeyB64).not.toBe(alice?.publicKeyB64);
    expect(window.localStorage.length).toBe(2);

    // Same username on a different server is a different account too.
    api.authSession.current = session('alice', 'https://other.example/');
    const elsewhere = await getOrCreateCollabSigningMaterial();

    expect(elsewhere?.publicKeyB64).not.toBe(alice?.publicKeyB64);
    expect(window.localStorage.length).toBe(3);
  });

  it('adopts the session username for a stored entry that predates it', async () => {
    api.authSession.current = session('alice');
    const created = await getOrCreateCollabSigningMaterial();
    const [key] = Object.keys(window.localStorage);
    window.localStorage.setItem(
      key,
      JSON.stringify({
        publicKeyB64: created?.publicKeyB64,
        privateKeyPkcs8B64: created?.privateKeyPkcs8B64
      })
    );

    const material = await getOrCreateCollabSigningMaterial();

    expect(material).toEqual(created);
  });

  it('regenerates over corrupt or half-written storage', async () => {
    api.authSession.current = session('alice');
    const created = await getOrCreateCollabSigningMaterial();
    const [key] = Object.keys(window.localStorage);

    window.localStorage.setItem(key, '{not json');
    const afterCorrupt = await getOrCreateCollabSigningMaterial();
    expect(afterCorrupt?.publicKeyB64).toBeTruthy();
    expect(afterCorrupt?.publicKeyB64).not.toBe(created?.publicKeyB64);

    // A private key without its public half is unusable — regenerate too.
    window.localStorage.setItem(
      key,
      JSON.stringify({ privateKeyPkcs8B64: 'orphan' })
    );
    const afterPartial = await getOrCreateCollabSigningMaterial();
    expect(afterPartial?.publicKeyB64).toBeTruthy();
    expect(afterPartial?.privateKeyPkcs8B64).not.toBe('orphan');

    window.localStorage.setItem(
      key,
      JSON.stringify({ publicKeyB64: 42, privateKeyPkcs8B64: 'wrong' })
    );
    const afterWrongTypes = await getOrCreateCollabSigningMaterial();
    expect(afterWrongTypes?.publicKeyB64).toBeTruthy();
    expect(afterWrongTypes?.privateKeyPkcs8B64).not.toBe('wrong');
  });

  describe('native vault credentials', () => {
    beforeEach(() => {
      native.isTauri.mockReturnValue(true);
      api.authSession.current = session('alice');
    });

    const legacyKey =
      'mindstream:collab-signing-key:v1:https%3A%2F%2Fetebase.example%2F:alice';
    const stored = {
      username: 'alice',
      publicKeyB64: 'existing-public',
      privateKeyPkcs8B64: 'existing-private'
    };

    it('uses the vault key before looking at legacy browser storage', async () => {
      native.get.mockResolvedValue(stored);
      window.localStorage.setItem(legacyKey, 'broken stale cache');
      expect(await getOrCreateCollabSigningMaterial()).toEqual(stored);
      expect(native.get).toHaveBeenCalledWith(
        'https://etebase.example/',
        'alice'
      );
      expect(native.store).not.toHaveBeenCalled();
    });

    it('imports the matching legacy identity and retains the source for recovery', async () => {
      const raw = JSON.stringify({
        publicKeyB64: stored.publicKeyB64,
        privateKeyPkcs8B64: stored.privateKeyPkcs8B64
      });
      window.localStorage.setItem(legacyKey, raw);
      expect(await getOrCreateCollabSigningMaterial()).toEqual(stored);
      expect(native.store).toHaveBeenCalledWith(
        'https://etebase.example/',
        stored
      );
      expect(window.localStorage.getItem(legacyKey)).toBe(raw);
    });

    it('does not regenerate keys or fall back when the secure store is unavailable', async () => {
      native.get.mockRejectedValue(new Error('keystore locked'));
      await expect(getOrCreateCollabSigningMaterial()).rejects.toThrow(
        'keystore locked'
      );
      expect(native.store).not.toHaveBeenCalled();
      expect(window.localStorage.length).toBe(0);
    });

    it('preserves malformed legacy identity instead of generating a replacement', async () => {
      window.localStorage.setItem(legacyKey, '{broken');
      await expect(getOrCreateCollabSigningMaterial()).rejects.toThrow(
        'needs recovery'
      );
      expect(native.store).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(legacyKey)).toBe('{broken');
    });

    it('retains the legacy source when importing into the vault fails', async () => {
      const raw = JSON.stringify(stored);
      window.localStorage.setItem(legacyKey, raw);
      native.store.mockRejectedValue(new Error('credential write failed'));
      await expect(getOrCreateCollabSigningMaterial()).rejects.toThrow(
        'credential write failed'
      );
      expect(window.localStorage.getItem(legacyKey)).toBe(raw);
    });

    it('uses the backend winner when another note window creates the key first', async () => {
      native.store.mockResolvedValue(stored);
      expect(await getOrCreateCollabSigningMaterial()).toEqual(stored);
      expect(native.store).toHaveBeenCalledOnce();
      expect(window.localStorage.length).toBe(0);
    });
  });
});
