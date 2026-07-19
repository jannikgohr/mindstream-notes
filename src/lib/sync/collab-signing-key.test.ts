import { describe, expect, it } from 'vitest';

import {
  collabAuthForRoom,
  type CollabSigningMaterial
} from './collab-signing-key';
import type { RoomInfo } from '$lib/api/sync';

function room(authorized: string[]): RoomInfo {
  return {
    room_id: 'room_1',
    key_b64: 'key',
    collab_epoch: 3,
    writer_auth: {
      authorized_writer_keys_b64: authorized
    }
  };
}

describe('collabAuthForRoom', () => {
  it('includes the private signing key only when the local public key is authorized', () => {
    const material: CollabSigningMaterial = {
      publicKeyB64: 'writer',
      privateKeyPkcs8B64: 'private'
    };

    const auth = collabAuthForRoom(room(['writer']), material);

    expect(auth?.authorPublicKeyB64).toBe('writer');
    expect(auth?.authorPrivateKeyPkcs8B64).toBe('private');
  });

  it('returns verify-only auth for view-only members', () => {
    const material: CollabSigningMaterial = {
      publicKeyB64: 'viewer',
      privateKeyPkcs8B64: 'private'
    };

    const auth = collabAuthForRoom(room(['writer']), material);

    expect(auth?.authorizedWriterKeysB64).toEqual(['writer']);
    expect(auth?.authorPublicKeyB64).toBeUndefined();
    expect(auth?.authorPrivateKeyPkcs8B64).toBeUndefined();
  });

  it('keeps legacy unscoped rooms unsigned', () => {
    const auth = collabAuthForRoom(
      { room_id: 'legacy', key_b64: 'key', collab_epoch: 0 },
      null
    );

    expect(auth).toBeUndefined();
  });
});
