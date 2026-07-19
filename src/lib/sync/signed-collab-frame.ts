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
  authorPublicKeyB64?: string;
  authorPrivateKeyPkcs8B64?: string;
  authorizedWriterKeysB64: string[];
}

type SigningCollabFrameAuth = CollabFrameAuth & {
  authorPublicKeyB64: string;
  authorPrivateKeyPkcs8B64: string;
};

interface SignedFrameHeader {
  v: number;
  t: number;
  r: string;
  e: number;
  a: string;
}

export interface DecodedCollabFrame {
  type: number;
  payload: Uint8Array;
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

export function canSignCollabFrame(
  auth: CollabFrameAuth | undefined
): auth is SigningCollabFrameAuth {
  return Boolean(auth?.authorPublicKeyB64 && auth.authorPrivateKeyPkcs8B64);
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
    a: auth.authorPublicKeyB64
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
  signedRequiredTypes: Set<number>
): boolean {
  return signedRequiredTypes.has(type);
}

export async function decodeCollabFrame(
  frame: Uint8Array,
  cryptoKey: CryptoKey,
  auth: CollabFrameAuth | undefined,
  signedRequiredTypes: Set<number>
): Promise<DecodedCollabFrame | null> {
  if (frame[0] !== SIGNED_FRAME_MARKER) {
    if (frame.byteLength < 1 + IV_LEN) return null;
    const type = frame[0];
    if (signedRequired(type, signedRequiredTypes) && auth) {
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

  if (frame.byteLength < 1 + 2) return null;
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
  if (header.v !== SIGNED_FRAME_VERSION || header.r !== auth?.roomId)
    return null;
  if (header.e !== auth.collabEpoch) return null;
  if (!auth.authorizedWriterKeysB64.includes(header.a)) return null;

  const verifyKey = await importVerifyKey(header.a);
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifyKey,
    arrayBuffer(signature),
    arrayBuffer(signaturePayload(headerBytes, iv, ciphertext))
  );
  if (!ok) return null;

  const payload = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv.slice().buffer },
      cryptoKey,
      ciphertext.slice().buffer
    )
  );
  return { type: header.t, payload };
}
