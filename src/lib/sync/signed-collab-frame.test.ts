import { describe, expect, it } from 'vitest';

import {
  decodeCollabFrame,
  encodeCollabFrame,
  generateCollabSigningKeyPair,
  signedCollabFrameNeedsAuthRefresh,
  type CollabFrameAuth
} from './signed-collab-frame';

const FRAME_SYNC_STEP_2 = 0x01;
const REQUIRED = new Set([FRAME_SYNC_STEP_2]);
const USERNAME = 'alice';

async function aesKey(fill = 7): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new Uint8Array(32).fill(fill).buffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

function tamperSignature(frame: Uint8Array): Uint8Array {
  const tampered = new Uint8Array(frame);
  const headerLen = (tampered[1] << 8) | tampered[2];
  const signatureStart = 1 + 2 + headerLen + 2;
  tampered[signatureStart] ^= 0xff;
  return tampered;
}

describe('signed collab frames', () => {
  it('round-trips signed writer frames', async () => {
    const key = await aesKey();
    const pair = await generateCollabSigningKeyPair();
    const auth: CollabFrameAuth = {
      roomId: 'room_1',
      collabEpoch: 3,
      authorUsername: USERNAME,
      authorPublicKeyB64: pair.publicKeyB64,
      authorPrivateKeyPkcs8B64: pair.privateKeyPkcs8B64,
      authorizedWriters: [
        { username: USERNAME, publicKeyB64: pair.publicKeyB64 }
      ]
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
        authorizedWriters: [
          { username: USERNAME, publicKeyB64: pair.publicKeyB64 }
        ]
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
        authorUsername: USERNAME,
        authorPublicKeyB64: writer.publicKeyB64,
        authorPrivateKeyPkcs8B64: writer.privateKeyPkcs8B64,
        authorizedWriters: [
          { username: USERNAME, publicKeyB64: writer.publicKeyB64 }
        ]
      }
    );
    const decoded = await decodeCollabFrame(
      frame,
      key,
      {
        roomId: 'room_1',
        collabEpoch: 1,
        authorizedWriters: [
          { username: USERNAME, publicKeyB64: other.publicKeyB64 }
        ]
      },
      REQUIRED
    );

    expect(decoded).toBeNull();
  });

  it('flags unknown signed writers for auth refresh in the same room epoch', async () => {
    const key = await aesKey();
    const writer = await generateCollabSigningKeyPair();
    const frame = await encodeCollabFrame(
      FRAME_SYNC_STEP_2,
      new Uint8Array([1]),
      key,
      {
        roomId: 'room_1',
        collabEpoch: 1,
        authorUsername: USERNAME,
        authorPublicKeyB64: writer.publicKeyB64,
        authorPrivateKeyPkcs8B64: writer.privateKeyPkcs8B64,
        authorizedWriters: [
          { username: USERNAME, publicKeyB64: writer.publicKeyB64 }
        ]
      }
    );

    expect(
      await signedCollabFrameNeedsAuthRefresh(frame, key, {
        roomId: 'room_1',
        collabEpoch: 1,
        authorizedWriters: []
      })
    ).toBe(true);
    expect(
      await signedCollabFrameNeedsAuthRefresh(frame, key, {
        roomId: 'room_2',
        collabEpoch: 1,
        authorizedWriters: []
      })
    ).toBe(false);
  });

  it('does not refresh auth for unknown writers with unverifiable frames', async () => {
    const key = await aesKey();
    const writer = await generateCollabSigningKeyPair();
    const frame = await encodeCollabFrame(
      FRAME_SYNC_STEP_2,
      new Uint8Array([1]),
      key,
      {
        roomId: 'room_1',
        collabEpoch: 1,
        authorUsername: USERNAME,
        authorPublicKeyB64: writer.publicKeyB64,
        authorPrivateKeyPkcs8B64: writer.privateKeyPkcs8B64,
        authorizedWriters: [
          { username: USERNAME, publicKeyB64: writer.publicKeyB64 }
        ]
      }
    );

    expect(
      await signedCollabFrameNeedsAuthRefresh(tamperSignature(frame), key, {
        roomId: 'room_1',
        collabEpoch: 1,
        authorizedWriters: []
      })
    ).toBe(false);
    expect(
      await signedCollabFrameNeedsAuthRefresh(frame, await aesKey(8), {
        roomId: 'room_1',
        collabEpoch: 1,
        authorizedWriters: []
      })
    ).toBe(false);
  });

  it('rejects signed frames when the key is authorized for a different username', async () => {
    const key = await aesKey();
    const writer = await generateCollabSigningKeyPair();
    const frame = await encodeCollabFrame(
      FRAME_SYNC_STEP_2,
      new Uint8Array([1]),
      key,
      {
        roomId: 'room_1',
        collabEpoch: 1,
        authorUsername: USERNAME,
        authorPublicKeyB64: writer.publicKeyB64,
        authorPrivateKeyPkcs8B64: writer.privateKeyPkcs8B64,
        authorizedWriters: [
          { username: USERNAME, publicKeyB64: writer.publicKeyB64 }
        ]
      }
    );
    const decoded = await decodeCollabFrame(
      frame,
      key,
      {
        roomId: 'room_1',
        collabEpoch: 1,
        authorizedWriters: [
          { username: 'bob', publicKeyB64: writer.publicKeyB64 }
        ]
      },
      REQUIRED
    );

    expect(decoded).toBeNull();
  });
});
