import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import crypto from 'node:crypto';
import { isJoinChallenge, signJoinChallenge } from './collab-join-challenge';

const HANDSHAKE_MARKER = 0xfe;
const HANDSHAKE_VERSION = 0x01;
const JOIN_CONTEXT = Buffer.from('mindstream-collab-join/v1', 'utf8');

function challengeFrame(nonce: Uint8Array): Uint8Array {
  const frame = new Uint8Array(2 + nonce.byteLength);
  frame[0] = HANDSHAKE_MARKER;
  frame[1] = HANDSHAKE_VERSION;
  frame.set(nonce, 2);
  return frame;
}

/** Generate a P-256 keypair in the same encodings Rust hands the client. */
async function keypair(): Promise<{ spkiB64: string; pkcs8B64: string }> {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const spki = new Uint8Array(
    await webcrypto.subtle.exportKey('spki', pair.publicKey)
  );
  const pkcs8 = new Uint8Array(
    await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)
  );
  return {
    spkiB64: Buffer.from(spki).toString('base64'),
    pkcs8B64: Buffer.from(pkcs8).toString('base64')
  };
}

/** The relay's verification, byte for byte — see collab-server.mjs. */
function relayVerifies(
  roomId: string,
  nonce: Uint8Array,
  response: Uint8Array
): boolean {
  if (response.byteLength !== 2 + 64) return false;
  if (response[0] !== HANDSHAKE_MARKER || response[1] !== HANDSHAKE_VERSION) {
    return false;
  }
  const key = crypto.createPublicKey({
    key: Buffer.from(roomId, 'base64'),
    format: 'der',
    type: 'spki'
  });
  const payload = Buffer.concat([
    JOIN_CONTEXT,
    Buffer.from(roomId, 'utf8'),
    Buffer.from(nonce)
  ]);
  return crypto.verify(
    'sha256',
    payload,
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(response.subarray(2))
  );
}

describe('isJoinChallenge', () => {
  it('accepts a well-formed challenge', () => {
    expect(isJoinChallenge(challengeFrame(new Uint8Array(32)))).toBe(true);
  });

  it('rejects data frames, including signed ones', () => {
    // 0x00-0x02 are frame types; 0xFF is the signed-frame marker. None may
    // be mistaken for a challenge, or a peer could stall our join.
    for (const marker of [0x00, 0x01, 0x02, 0xff]) {
      const frame = challengeFrame(new Uint8Array(32));
      frame[0] = marker;
      expect(isJoinChallenge(frame)).toBe(false);
    }
  });

  it('rejects a wrong-length nonce and a bad version', () => {
    expect(isJoinChallenge(challengeFrame(new Uint8Array(16)))).toBe(false);
    const wrongVersion = challengeFrame(new Uint8Array(32));
    wrongVersion[1] = 0x02;
    expect(isJoinChallenge(wrongVersion)).toBe(false);
  });
});

describe('signJoinChallenge', () => {
  it('produces a response the relay accepts', async () => {
    const { spkiB64, pkcs8B64 } = await keypair();
    const nonce = webcrypto.getRandomValues(new Uint8Array(32));

    const response = await signJoinChallenge(
      challengeFrame(nonce),
      spkiB64,
      pkcs8B64
    );

    expect(response).not.toBeNull();
    expect(relayVerifies(spkiB64, nonce, response!)).toBe(true);
  });

  it('will not answer for a room it lacks the key to', async () => {
    // Signing with one room's key must not open another room, or the
    // challenge would prove nothing about *this* room's secret.
    const room = await keypair();
    const other = await keypair();
    const nonce = webcrypto.getRandomValues(new Uint8Array(32));

    const response = await signJoinChallenge(
      challengeFrame(nonce),
      room.spkiB64,
      other.pkcs8B64
    );

    expect(response).not.toBeNull();
    expect(relayVerifies(room.spkiB64, nonce, response!)).toBe(false);
  });

  it('binds the signature to the nonce', async () => {
    const { spkiB64, pkcs8B64 } = await keypair();
    const nonce = webcrypto.getRandomValues(new Uint8Array(32));

    const response = await signJoinChallenge(
      challengeFrame(nonce),
      spkiB64,
      pkcs8B64
    );

    // Replaying a captured response against a fresh nonce must fail —
    // that is what stops a captured handshake from being reusable.
    const replayNonce = webcrypto.getRandomValues(new Uint8Array(32));
    expect(relayVerifies(spkiB64, replayNonce, response!)).toBe(false);
  });

  it('returns null for a malformed challenge or unusable key', async () => {
    const { spkiB64, pkcs8B64 } = await keypair();

    expect(
      await signJoinChallenge(new Uint8Array([0x01, 0x02]), spkiB64, pkcs8B64)
    ).toBeNull();
    expect(
      await signJoinChallenge(
        challengeFrame(new Uint8Array(32)),
        spkiB64,
        'not-base64-pkcs8'
      )
    ).toBeNull();
  });
});
