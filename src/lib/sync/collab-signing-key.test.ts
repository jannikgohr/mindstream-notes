import { describe, expect, it } from 'vitest';

import {
  collabAuthForRoom,
  type CollabSigningMaterial
} from './collab-signing-key';
import type { RoomInfo } from '$lib/api/sync';

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
