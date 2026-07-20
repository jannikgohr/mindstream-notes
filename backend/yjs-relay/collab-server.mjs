#!/usr/bin/env node
/**
 * Mindstream Notes — collab relay (E2EE).
 *
 * Pure broadcast hub. The client's CollabProvider AES-GCM-encrypts every
 * frame using a per-note key shared via etebase, so this server never
 * sees plaintext y.js updates and doesn't need to. It just relays
 * binary frames between clients in the same room.
 *
 * Wire format (opaque to this server): [1 byte type][12 byte IV][N bytes ciphertext+tag].
 *
 * ## Join challenge
 *
 * The room id is not a name, it's the *public half* of a P-256 keypair the
 * client derives from the room secret (see derive_collab_join_keypair in
 * src-tauri/src/sync/mod.rs). So we can authenticate a join by handing the
 * socket a random nonce and checking the signature against the room id we
 * were already given in the URL — while holding no secret, no per-room
 * state, and no knowledge of who any of these people are.
 *
 * That keeps the relay dumb on purpose. What it buys over "the room id is
 * an unguessable bearer token" is that the id travels in the query string,
 * so it lands in access logs and proxy logs; with the challenge, seeing an
 * id is no longer enough to join it.
 *
 * This proves *membership*, not identity or role — every member of a room
 * derives the same keypair. Authorship and write-access enforcement live in
 * the per-writer frame signatures, not here.
 *
 *   relay  → client   [0xFE][0x01][32-byte nonce]
 *   client → relay    [0xFE][0x01][64-byte P-1363 signature]
 *   signed payload    "mindstream-collab-join/v1" ‖ room-id ‖ nonce
 *
 * Run:
 *   node backend/yjs-relay/collab-server.mjs           # binds 0.0.0.0:1234
 *   PORT=8080 HOST=127.0.0.1 node ...                  # override
 *
 * Deployed behind the backend/ nginx in docker-compose, which forwards
 * root-path WebSocket upgrades here (everything not under /socket.io/,
 * which goes to excalidraw-room for freeform live sync).
 */

import uWS from 'uWebSockets.js';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT ?? 1234);
const HOST = process.env.HOST ?? '0.0.0.0';

const MAX_PAYLOAD_LENGTH = 16 * 1024 * 1024;
// Drop peers whose outbound queue grows past this. Frames are encrypted
// ciphertext, so we can't coalesce or merge a slow consumer's backlog —
// disconnecting and letting the client resync is the cleanest option.
const MAX_BACKPRESSURE_BYTES = 4 * 1024 * 1024; // 4 MiB

const HANDSHAKE_MARKER = 0xfe;
const HANDSHAKE_VERSION = 0x01;
const NONCE_LEN = 32;
// Raw ECDSA P-256 r‖s. WebCrypto's sign() emits this (IEEE P-1363), not the
// DER form node's verify() defaults to — hence dsaEncoding below.
const SIGNATURE_LEN = 64;
const JOIN_CONTEXT = Buffer.from('mindstream-collab-join/v1', 'utf8');
const AUTH_TIMEOUT_MS = 10_000;

// A room id is base64 of a P-256 SubjectPublicKeyInfo DER. Mirrors
// valid_collab_writer_public_key() on the Rust side.
const P256_SPKI_DER_LEN = 91;
const P256_SPKI_DER_PREFIX = Buffer.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  0x04
]);

/** Parse a room id into a verify key, or null if it isn't a P-256 SPKI. */
function roomVerifyKey(room) {
  let der;
  try {
    der = Buffer.from(room, 'base64');
  } catch {
    return null;
  }
  if (der.byteLength !== P256_SPKI_DER_LEN) return null;
  if (
    !der
      .subarray(0, P256_SPKI_DER_PREFIX.byteLength)
      .equals(P256_SPKI_DER_PREFIX)
  ) {
    return null;
  }
  try {
    return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

function verifyJoinSignature(ws, frame) {
  if (frame.byteLength !== 2 + SIGNATURE_LEN) return false;
  if (frame[0] !== HANDSHAKE_MARKER || frame[1] !== HANDSHAKE_VERSION) {
    return false;
  }
  const signature = frame.subarray(2);
  const payload = Buffer.concat([
    JOIN_CONTEXT,
    Buffer.from(ws.room, 'utf8'),
    ws.nonce
  ]);
  try {
    return crypto.verify(
      'sha256',
      payload,
      { key: ws.verifyKey, dsaEncoding: 'ieee-p1363' },
      signature
    );
  } catch {
    return false;
  }
}

// Pending auth deadlines, so a socket that connects and then says nothing
// can't sit there holding a slot.
const authTimers = new Map();

function clearAuthTimer(ws) {
  const timer = authTimers.get(ws);
  if (timer !== undefined) {
    clearTimeout(timer);
    authTimers.delete(ws);
  }
}

const app = uWS.App();

app.ws('/*', {
  // Payloads are AES-GCM ciphertext; permessage-deflate burns CPU for
  // ~0% compression and would only hurt throughput.
  compression: uWS.DISABLED,
  maxPayloadLength: MAX_PAYLOAD_LENGTH,
  idleTimeout: 120,

  upgrade: (res, req, context) => {
    const query = req.getQuery() ?? '';
    // URLSearchParams.get() returns the percent-decoded value, which
    // matches the client's encodeURIComponent on the room id.
    const room = new URLSearchParams(query).get('room');
    if (!room) {
      res.writeStatus('400 Bad Request').end('missing room param');
      return;
    }
    // Reject a malformed room before allocating a socket for it.
    const verifyKey = roomVerifyKey(room);
    if (!verifyKey) {
      res.writeStatus('400 Bad Request').end('malformed room param');
      return;
    }
    res.upgrade(
      { room, verifyKey, authed: false, nonce: null },
      req.getHeader('sec-websocket-key'),
      req.getHeader('sec-websocket-protocol'),
      req.getHeader('sec-websocket-extensions'),
      context
    );
  },

  open: (ws) => {
    // Not subscribed until the challenge is answered: an unauthenticated
    // socket must not receive a single frame from the room. uWS pub/sub
    // fans out natively in C++ and ws.publish() skips the sender, so once
    // subscribed we never iterate a JS Set per inbound frame.
    ws.nonce = crypto.randomBytes(NONCE_LEN);
    const challenge = Buffer.concat([
      Buffer.from([HANDSHAKE_MARKER, HANDSHAKE_VERSION]),
      ws.nonce
    ]);
    ws.send(challenge, true);
    authTimers.set(
      ws,
      setTimeout(() => {
        authTimers.delete(ws);
        try {
          ws.end(1008, 'auth timeout');
        } catch {
          /* already gone */
        }
      }, AUTH_TIMEOUT_MS)
    );
  },

  message: (ws, message, isBinary) => {
    if (!ws.authed) {
      // Copy: uWS reuses the ArrayBuffer backing `message` after this
      // callback returns.
      const frame = Buffer.from(new Uint8Array(message));
      clearAuthTimer(ws);
      if (!verifyJoinSignature(ws, frame)) {
        ws.end(1008, 'auth failed');
        return;
      }
      ws.authed = true;
      ws.nonce = null;
      ws.subscribe(ws.room);
      return;
    }
    if (ws.getBufferedAmount() > MAX_BACKPRESSURE_BYTES) {
      // The sender's own socket is backed up — disconnect rather than
      // feed more bytes into a stuck queue.
      ws.end(1009, 'backpressure');
      return;
    }
    ws.publish(ws.room, message, isBinary, false);
  },

  drain: (ws) => {
    // Fires when this socket's outbound buffer drains. If it's still
    // huge, the subscriber can't keep up — drop them.
    if (ws.getBufferedAmount() > MAX_BACKPRESSURE_BYTES) {
      ws.end(1009, 'backpressure');
    }
  },

  close: (ws) => {
    clearAuthTimer(ws);
  }
});

app.listen(HOST, PORT, (token) => {
  if (token) {
    console.log(`[collab] relay listening on ws://${HOST}:${PORT}`);
  } else {
    console.error(`[collab] failed to bind ${HOST}:${PORT}`);
    process.exit(1);
  }
});
