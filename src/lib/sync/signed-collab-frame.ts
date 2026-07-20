const SIGNED_FRAME_MARKER = 0xff;
const SIGNED_FRAME_VERSION = 1;
const IV_LEN = 12;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type NodeBufferShim = {
  from(
    value: Uint8Array | string,
    encoding?: 'base64'
  ): Uint8Array & {
    toString(encoding: 'base64'): string;
  };
};

function nodeBuffer(): NodeBufferShim | undefined {
  return (globalThis as { Buffer?: NodeBufferShim }).Buffer;
}

export interface CollabFrameAuth {
  roomId: string;
  collabEpoch: number;
  authorUsername?: string;
  authorPublicKeyB64?: string;
  authorPrivateKeyPkcs8B64?: string;
  authorizedWriters: Array<{
    username: string;
    publicKeyB64: string;
  }>;
}

type SigningCollabFrameAuth = CollabFrameAuth & {
  authorUsername: string;
  authorPublicKeyB64: string;
  authorPrivateKeyPkcs8B64: string;
};

interface SignedFrameHeader {
  v: number;
  t: number;
  r: string;
  e: number;
  a: string;
  u: string;
  /** Milliseconds since the epoch, set by the sender and covered by the
   *  signature. Bounds how long a captured frame stays replayable, and lets
   *  the receiver's replay cache expire entries instead of growing forever. */
  ts: number;
}

export interface DecodedCollabFrame {
  type: number;
  payload: Uint8Array;
}

export interface SignedCollabFrameHeaderInfo {
  roomId: string;
  collabEpoch: number;
  authorUsername: string;
  authorPublicKeyB64: string;
}

interface SignedCollabFrameParts {
  header: SignedFrameHeader;
  headerBytes: Uint8Array;
  signature: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

function bytesToBase64(bytes: Uint8Array): string {
  const buffer = nodeBuffer();
  if (typeof btoa !== 'function' && buffer) {
    return buffer.from(bytes).toString('base64');
  }
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
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

function writeU16(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >> 8) & 0xff;
  out[offset + 1] = value & 0xff;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function signaturePayload(
  headerBytes: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array
) {
  return concatBytes([
    textEncoder.encode('mindstream-collab-frame/v1'),
    headerBytes,
    iv,
    ciphertext
  ]);
}

async function importSigningKey(pkcs8B64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    arrayBuffer(base64ToBytes(pkcs8B64)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

async function importVerifyKey(spkiB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    arrayBuffer(base64ToBytes(spkiB64)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
}

export async function generateCollabSigningKeyPair(): Promise<{
  publicKeyB64: string;
  privateKeyPkcs8B64: string;
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey('spki', keyPair.publicKey)
  );
  const privateKey = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
  );
  return {
    publicKeyB64: bytesToBase64(publicKey),
    privateKeyPkcs8B64: bytesToBase64(privateKey)
  };
}

/** How far a frame's timestamp may sit from our clock before we drop it.
 *  Generous enough to absorb ordinary device clock skew. */
const REPLAY_WINDOW_MS = 5 * 60_000;

/**
 * Rejects frames we've already seen, and frames too old to still be in play.
 *
 * Signed frames bind the room and epoch but nothing per-message, so before
 * this a captured frame stayed valid for the life of its epoch and could be
 * re-injected by the relay or any room peer. Yjs updates are idempotent so a
 * replayed document update is mostly a no-op, but a replayed awareness frame
 * resurrects a stale cursor, and neither should be possible.
 *
 * Identity is the signature itself: every frame carries a fresh random IV that
 * the signature covers, so two distinct frames can't share one.
 */
export class CollabReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly windowMs: number = REPLAY_WINDOW_MS) {}

  /** True if the frame is fresh and unseen; recording it as seen. */
  accept(timestamp: number, signature: Uint8Array, now = Date.now()): boolean {
    if (!Number.isFinite(timestamp)) return false;
    if (Math.abs(now - timestamp) > this.windowMs) return false;

    const key = bytesToBase64(signature);
    const expiry = this.seen.get(key);
    if (expiry !== undefined && expiry > now) return false;

    // Sweep on write: the map only ever holds one window's worth of frames.
    if (this.seen.size > 0) {
      for (const [seenKey, seenExpiry] of this.seen) {
        if (seenExpiry <= now) this.seen.delete(seenKey);
      }
    }
    this.seen.set(key, now + this.windowMs);
    return true;
  }
}

export function canSignCollabFrame(
  auth: CollabFrameAuth | undefined
): auth is SigningCollabFrameAuth {
  return Boolean(
    auth?.authorUsername &&
    auth.authorPublicKeyB64 &&
    auth.authorPrivateKeyPkcs8B64 &&
    authorizedWriter(auth, auth.authorUsername, auth.authorPublicKeyB64)
  );
}

function authorizedWriter(
  auth: CollabFrameAuth,
  username: string,
  publicKeyB64: string
): boolean {
  return auth.authorizedWriters.some(
    (writer) =>
      writer.username === username && writer.publicKeyB64 === publicKeyB64
  );
}

export function isSignedCollabFrame(frame: Uint8Array): boolean {
  return frame[0] === SIGNED_FRAME_MARKER;
}

export function signedCollabFrameHeader(
  frame: Uint8Array
): SignedCollabFrameHeaderInfo | null {
  const parts = parseSignedCollabFrame(frame);
  if (!parts) return null;
  return {
    roomId: parts.header.r,
    collabEpoch: parts.header.e,
    authorUsername: parts.header.u,
    authorPublicKeyB64: parts.header.a
  };
}

export async function signedCollabFrameNeedsAuthRefresh(
  frame: Uint8Array,
  cryptoKey: CryptoKey,
  auth: CollabFrameAuth | undefined
): Promise<boolean> {
  if (!auth) return false;
  const parts = parseSignedCollabFrame(frame);
  if (!parts) return false;
  if (parts.header.r !== auth.roomId || parts.header.e !== auth.collabEpoch) {
    return false;
  }
  if (authorizedWriter(auth, parts.header.u, parts.header.a)) return false;

  try {
    const verifyKey = await importVerifyKey(parts.header.a);
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      arrayBuffer(parts.signature),
      arrayBuffer(
        signaturePayload(parts.headerBytes, parts.iv, parts.ciphertext)
      )
    );
    if (!ok) return false;
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: parts.iv.slice().buffer },
      cryptoKey,
      parts.ciphertext.slice().buffer
    );
    return true;
  } catch {
    return false;
  }
}

export async function encodeCollabFrame(
  type: number,
  payload: Uint8Array,
  cryptoKey: CryptoKey,
  auth?: CollabFrameAuth
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv.slice().buffer },
      cryptoKey,
      payload.slice().buffer
    )
  );

  if (!canSignCollabFrame(auth)) {
    const frame = new Uint8Array(1 + IV_LEN + ciphertext.byteLength);
    frame[0] = type;
    frame.set(iv, 1);
    frame.set(ciphertext, 1 + IV_LEN);
    return frame;
  }

  const header: SignedFrameHeader = {
    v: SIGNED_FRAME_VERSION,
    t: type,
    r: auth.roomId,
    e: auth.collabEpoch,
    a: auth.authorPublicKeyB64,
    u: auth.authorUsername,
    ts: Date.now()
  };
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  const signingKey = await importSigningKey(auth.authorPrivateKeyPkcs8B64);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingKey,
      arrayBuffer(signaturePayload(headerBytes, iv, ciphertext))
    )
  );
  if (headerBytes.byteLength > 0xffff || signature.byteLength > 0xffff) {
    throw new Error('signed collab frame header/signature too large');
  }

  const frame = new Uint8Array(
    1 +
      2 +
      headerBytes.byteLength +
      2 +
      signature.byteLength +
      IV_LEN +
      ciphertext.byteLength
  );
  let offset = 0;
  frame[offset++] = SIGNED_FRAME_MARKER;
  writeU16(frame, offset, headerBytes.byteLength);
  offset += 2;
  frame.set(headerBytes, offset);
  offset += headerBytes.byteLength;
  writeU16(frame, offset, signature.byteLength);
  offset += 2;
  frame.set(signature, offset);
  offset += signature.byteLength;
  frame.set(iv, offset);
  offset += IV_LEN;
  frame.set(ciphertext, offset);
  return frame;
}

function signedRequired(
  type: number,
  signedRequiredTypes: ReadonlySet<number>
): boolean {
  return signedRequiredTypes.has(type);
}

export async function decodeCollabFrame(
  frame: Uint8Array,
  cryptoKey: CryptoKey,
  auth: CollabFrameAuth | undefined,
  signedRequiredTypes: ReadonlySet<number>,
  replayGuard?: CollabReplayGuard
): Promise<DecodedCollabFrame | null> {
  if (frame[0] !== SIGNED_FRAME_MARKER) {
    if (frame.byteLength < 1 + IV_LEN) return null;
    const type = frame[0];
    // Note the absence of an `&& auth` guard. Enforcement is driven purely by
    // the type set the caller declared: if a room requires signed writes, an
    // unsigned frame is rejected even when we failed to resolve who the
    // authorised writers are. Keying this off `auth` being truthy would mean
    // a room whose authorisation lookup failed silently accepted anything.
    if (signedRequired(type, signedRequiredTypes)) {
      console.warn('[collab] rejected unsigned writer frame type=%d', type);
      return null;
    }
    const iv = frame.subarray(1, 1 + IV_LEN);
    const ciphertext = frame.subarray(1 + IV_LEN);
    const payload = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv.slice().buffer },
        cryptoKey,
        ciphertext.slice().buffer
      )
    );
    return { type, payload };
  }

  const parts = parseSignedCollabFrame(frame);
  if (!parts) return null;
  const { header, headerBytes, signature, iv, ciphertext } = parts;

  if (header.v !== SIGNED_FRAME_VERSION || header.r !== auth?.roomId)
    return null;
  if (header.e !== auth.collabEpoch) return null;
  if (!authorizedWriter(auth, header.u, header.a)) return null;

  const verifyKey = await importVerifyKey(header.a);
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifyKey,
    arrayBuffer(signature),
    arrayBuffer(signaturePayload(headerBytes, iv, ciphertext))
  );
  if (!ok) return null;

  // After signature verification: an attacker must not be able to evict
  // cache entries with frames they didn't legitimately obtain.
  if (replayGuard && !replayGuard.accept(header.ts, signature)) {
    console.warn('[collab] dropped replayed or stale frame type=%d', header.t);
    return null;
  }

  const payload = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv.slice().buffer },
      cryptoKey,
      ciphertext.slice().buffer
    )
  );
  return { type: header.t, payload };
}

function parseSignedCollabFrame(
  frame: Uint8Array
): SignedCollabFrameParts | null {
  if (!isSignedCollabFrame(frame) || frame.byteLength < 1 + 2) return null;
  let offset = 1;
  const headerLen = readU16(frame, offset);
  offset += 2;
  if (frame.byteLength < offset + headerLen + 2 + IV_LEN) return null;
  const headerBytes = frame.subarray(offset, offset + headerLen);
  offset += headerLen;
  const sigLen = readU16(frame, offset);
  offset += 2;
  if (frame.byteLength < offset + sigLen + IV_LEN) return null;
  const signature = frame.subarray(offset, offset + sigLen);
  offset += sigLen;
  const iv = frame.subarray(offset, offset + IV_LEN);
  offset += IV_LEN;
  const ciphertext = frame.subarray(offset);

  let header: SignedFrameHeader;
  try {
    header = JSON.parse(textDecoder.decode(headerBytes)) as SignedFrameHeader;
  } catch {
    return null;
  }
  if (header.v !== SIGNED_FRAME_VERSION) return null;
  if (
    typeof header.t !== 'number' ||
    typeof header.r !== 'string' ||
    typeof header.e !== 'number' ||
    typeof header.a !== 'string' ||
    typeof header.u !== 'string' ||
    typeof header.ts !== 'number'
  ) {
    return null;
  }
  return { header, headerBytes, signature, iv, ciphertext };
}
