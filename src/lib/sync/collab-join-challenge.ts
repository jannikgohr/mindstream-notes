/**
 * Relay join challenge — client half.
 *
 * The relay names each room after the *public* half of a P-256 keypair that
 * Rust derives from the room secret (`derive_collab_join_keypair` in
 * src-tauri/src/sync/mod.rs). On connect the relay sends a random nonce; we
 * sign it with the private half, proving we can derive the room secret
 * without the relay ever holding one. See the header of
 * backend/yjs-relay/collab-server.mjs for the protocol and its limits.
 *
 *   relay  → client   [0xFE][0x01][32-byte nonce]
 *   client → relay    [0xFE][0x01][64-byte P-1363 signature]
 *   signed payload    "mindstream-collab-join/v1" ‖ room-id ‖ nonce
 *
 * 0xFE can't collide with a data frame: those lead with a frame-type byte
 * (0x00-0x02) or the signed-frame marker 0xFF.
 */

const HANDSHAKE_MARKER = 0xfe;
const HANDSHAKE_VERSION = 0x01;
const NONCE_LEN = 32;

const textEncoder = new TextEncoder();
const JOIN_CONTEXT = textEncoder.encode('mindstream-collab-join/v1');

type NodeBufferShim = {
  from(value: string, encoding: 'base64'): Uint8Array;
};

function nodeBuffer(): NodeBufferShim | undefined {
  return (globalThis as { Buffer?: NodeBufferShim }).Buffer;
}

function base64ToBytes(value: string): Uint8Array {
  const buffer = nodeBuffer();
  if (typeof atob !== 'function' && buffer) {
    return new Uint8Array(buffer.from(value, 'base64'));
  }
  const bin = atob(value);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

/** True for the relay's challenge frame. Cheap enough to run per message. */
export function isJoinChallenge(frame: Uint8Array): boolean {
  return (
    frame.byteLength === 2 + NONCE_LEN &&
    frame[0] === HANDSHAKE_MARKER &&
    frame[1] === HANDSHAKE_VERSION
  );
}

/**
 * Answer a challenge frame. Returns the response frame, or `null` if the
 * challenge is malformed or the key won't import — callers should treat that
 * as "cannot join" rather than retrying, since neither failure is transient.
 */
export async function signJoinChallenge(
  challenge: Uint8Array,
  roomId: string,
  privateKeyPkcs8B64: string
): Promise<Uint8Array | null> {
  if (!isJoinChallenge(challenge)) return null;
  const nonce = challenge.subarray(2);
  try {
    const key = await crypto.subtle.importKey(
      'pkcs8',
      arrayBuffer(base64ToBytes(privateKeyPkcs8B64)),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
    // WebCrypto emits IEEE P-1363 (raw r‖s); the relay verifies with
    // dsaEncoding: 'ieee-p1363' to match.
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        arrayBuffer(
          concatBytes([JOIN_CONTEXT, textEncoder.encode(roomId), nonce])
        )
      )
    );
    return concatBytes([
      new Uint8Array([HANDSHAKE_MARKER, HANDSHAKE_VERSION]),
      signature
    ]);
  } catch (err) {
    console.warn('[collab] join challenge signing failed:', err);
    return null;
  }
}
