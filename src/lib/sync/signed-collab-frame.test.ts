import { describe, expect, it } from 'vitest';

import {
  decodeCollabFrame,
  encodeCollabFrame,
  generateCollabSigningKeyPair,
  type CollabFrameAuth
} from './signed-collab-frame';

const FRAME_SYNC_STEP_2 = 0x01;
const REQUIRED = new Set([FRAME_SYNC_STEP_2]);

async function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new Uint8Array(32).fill(7).buffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

describe('signed collab frames', () => {
  it('round-trips signed writer frames', async () => {
    const key = await aesKey();
    const pair = await generateCollabSigningKeyPair();
    const auth: CollabFrameAuth = {
      roomId: 'room_1',
      collabEpoch: 3,
      authorPublicKeyB64: pair.publicKeyB64,
      authorPrivateKeyPkcs8B64: pair.privateKeyPkcs8B64,
      authorizedWriterKeysB64: [pair.publicKeyB64]
    };

    const frame = await encodeCollabFrame(
      FRAME_SYNC_STEP_2,
      new Uint8Array([1, 2, 3]),
      key,
      auth
    );
    const decoded = await decodeCollabFrame(frame, key, auth, REQUIRED);

    expect(decoded?.type).toBe(FRAME_SYNC_STEP_2);
    expect(Array.from(decoded?.payload ?? [])).toEqual([1, 2, 3]);
  });

  it('rejects unsigned writer frames when writer keys are known', async () => {
    const key = await aesKey();
    const pair = await generateCollabSigningKeyPair();
    const frame = await encodeCollabFrame(
      FRAME_SYNC_STEP_2,
      new Uint8Array([1]),
      key
    );
    const decoded = await decodeCollabFrame(
      frame,
      key,
      {
        roomId: 'room_1',
        collabEpoch: 1,
        authorizedWriterKeysB64: [pair.publicKeyB64]
      },
      REQUIRED
    );

    expect(decoded).toBeNull();
  });

  it('rejects signed frames from keys outside the authorized writer set', async () => {
    const key = await aesKey();
    const writer = await generateCollabSigningKeyPair();
    const other = await generateCollabSigningKeyPair();
    const frame = await encodeCollabFrame(
      FRAME_SYNC_STEP_2,
      new Uint8Array([1]),
      key,
      {
        roomId: 'room_1',
        collabEpoch: 1,
        authorPublicKeyB64: writer.publicKeyB64,
        authorPrivateKeyPkcs8B64: writer.privateKeyPkcs8B64,
        authorizedWriterKeysB64: [writer.publicKeyB64]
      }
    );
    const decoded = await decodeCollabFrame(
      frame,
      key,
      {
        roomId: 'room_1',
        collabEpoch: 1,
        authorizedWriterKeysB64: [other.publicKeyB64]
      },
      REQUIRED
    );

    expect(decoded).toBeNull();
  });
});
