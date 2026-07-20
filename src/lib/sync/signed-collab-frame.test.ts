import { describe, expect, it } from 'vitest';

import {
  decodeCollabFrame,
  encodeCollabFrame,
  generateCollabSigningKeyPair,
  isSignedCollabFrame,
  signedCollabFrameHeader,
  signedCollabFrameNeedsAuthRefresh,
  type CollabFrameAuth
} from './signed-collab-frame';

const FRAME_SYNC_STEP_2 = 0x01;
const FRAME_AWARENESS = 0x03;
const REQUIRED = new Set([FRAME_SYNC_STEP_2]);
const USERNAME = 'alice';
const SIGNED_FRAME_MARKER = 0xff;
const IV_LEN = 12;

/**
 * A structurally valid signed frame carrying an arbitrary header blob, so the
 * parser's rejection paths can be reached with bytes a peer could actually put
 * on the wire (the encoder can only ever produce well-formed headers).
 */
function frameWithRawHeader(header: string): Uint8Array {
  const headerBytes = new TextEncoder().encode(header);
  const frame = new Uint8Array(1 + 2 + headerBytes.byteLength + 2 + IV_LEN + 4);
  let offset = 0;
  frame[offset++] = SIGNED_FRAME_MARKER;
  frame[offset++] = (headerBytes.byteLength >> 8) & 0xff;
  frame[offset++] = headerBytes.byteLength & 0xff;
  frame.set(headerBytes, offset);
  offset += headerBytes.byteLength;
  // Zero-length signature; parsing must fail before verification is reached.
  frame[offset++] = 0;
  frame[offset++] = 0;
  return frame;
}

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

  /**
   * Regression guard for a fail-open: enforcement used to be conditional on
   * `auth` being truthy, so a scoped room whose authorised-writer lookup came
   * back empty would silently accept unsigned document updates from anyone
   * holding the room key — including a read-only member.
   */
  it('rejects unsigned writer frames even when auth is unresolved', async () => {
    const key = await aesKey();
    const frame = await encodeCollabFrame(
      FRAME_SYNC_STEP_2,
      new Uint8Array([1]),
      key
    );

    expect(await decodeCollabFrame(frame, key, undefined, REQUIRED)).toBeNull();
  });

  it('still accepts unsigned frames when no type is declared signed', async () => {
    // Unshared rooms declare an empty required-set; only this device holds
    // the key, so there is nobody to authenticate against.
    const key = await aesKey();
    const frame = await encodeCollabFrame(
      FRAME_SYNC_STEP_2,
      new Uint8Array([1]),
      key
    );

    const decoded = await decodeCollabFrame(
      frame,
      key,
      undefined,
      new Set<number>()
    );

    expect(decoded?.type).toBe(FRAME_SYNC_STEP_2);
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

  it('round-trips unsigned frames for types that do not require a signature', async () => {
    // Awareness/presence traffic stays unsigned even in a signed room, so a
    // view-only peer's cursor still arrives.
    const key = await aesKey();
    const writer = await generateCollabSigningKeyPair();
    const frame = await encodeCollabFrame(
      FRAME_AWARENESS,
      new Uint8Array([9, 9]),
      key
    );

    expect(isSignedCollabFrame(frame)).toBe(false);

    const decoded = await decodeCollabFrame(
      frame,
      key,
      {
        roomId: 'room_1',
        collabEpoch: 1,
        authorizedWriters: [
          { username: USERNAME, publicKeyB64: writer.publicKeyB64 }
        ]
      },
      REQUIRED
    );

    expect(decoded?.type).toBe(FRAME_AWARENESS);
    expect(Array.from(decoded?.payload ?? [])).toEqual([9, 9]);
  });

  it('exposes the signing identity of a frame without decrypting it', async () => {
    const key = await aesKey();
    const writer = await generateCollabSigningKeyPair();
    const frame = await encodeCollabFrame(
      FRAME_SYNC_STEP_2,
      new Uint8Array([1]),
      key,
      {
        roomId: 'room_1',
        collabEpoch: 4,
        authorUsername: USERNAME,
        authorPublicKeyB64: writer.publicKeyB64,
        authorPrivateKeyPkcs8B64: writer.privateKeyPkcs8B64,
        authorizedWriters: [
          { username: USERNAME, publicKeyB64: writer.publicKeyB64 }
        ]
      }
    );

    expect(isSignedCollabFrame(frame)).toBe(true);
    expect(signedCollabFrameHeader(frame)).toEqual({
      roomId: 'room_1',
      collabEpoch: 4,
      authorUsername: USERNAME,
      authorPublicKeyB64: writer.publicKeyB64
    });
  });

  it('has no header for unsigned or malformed frames', async () => {
    const key = await aesKey();
    const unsigned = await encodeCollabFrame(
      FRAME_AWARENESS,
      new Uint8Array([1]),
      key
    );

    expect(signedCollabFrameHeader(unsigned)).toBeNull();
    // Header that isn't JSON at all.
    expect(signedCollabFrameHeader(frameWithRawHeader('not json'))).toBeNull();
    // Right version, but the typed fields a verifier relies on are missing.
    expect(
      signedCollabFrameHeader(frameWithRawHeader('{"v":1,"r":"room_1"}'))
    ).toBeNull();
    // Truncated before the header even ends.
    expect(
      signedCollabFrameHeader(new Uint8Array([SIGNED_FRAME_MARKER, 0x00, 0x40]))
    ).toBeNull();
  });
});
