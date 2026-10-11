/**
 * Live-collaboration transports: the yjs-relay (markdown, PDF, kanban, ink)
 * and excalidraw-room (freeform).
 *
 * `joinRoom` is the one place that knows how a client proves it may enter a
 * room. Today that is the relay's join challenge: the room id is the public
 * half of a keypair derived from the note key, and the client signs a nonce
 * with the private half. A server that authorises joins some other way needs
 * a different `joinRoom` and nothing else in this file.
 *
 * Frames are opaque to both servers, so the latency scenarios send random
 * bytes of a realistic size and skip the AES-GCM a real client would apply.
 */

import {
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  sign
} from 'node:crypto';
import { io } from 'socket.io-client';
import WebSocket from 'ws';

// Mirrors of src-tauri/src/sync/mod.rs and backend/yjs-relay/collab-server.mjs.
const LIVE_COLLAB_KEY_INFO = Buffer.from('mindstream-live-collab-key/v1');
const LIVE_COLLAB_JOIN_INFO = Buffer.from('mindstream-live-collab-join/v1');
const JOIN_CONTEXT = Buffer.from('mindstream-collab-join/v1');
const HANDSHAKE = Buffer.from([0xfe, 0x01]);
const NONCE_LEN = 32;
/** PKCS#8 wrapper for a bare P-256 scalar; the 32 key bytes follow it. */
const P256_PKCS8_PREFIX = Buffer.from(
  '3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420',
  'hex'
);

const FRAME_TIMEOUT_MS = 10_000;

/**
 * `derive_live_collab_room`: the AES-GCM wire key and the join keypair, both
 * HKDF'd from the per-note key. Local work, no requests.
 */
export function deriveRoom({ noteUid, noteKey, salt, epoch }) {
  const epochBytes = Buffer.alloc(8);
  epochBytes.writeBigUInt64BE(BigInt(epoch));
  const uid = Buffer.from(noteUid, 'utf8');
  const hkdfSalt = salt ?? Buffer.alloc(0);
  const expand = (info) =>
    Buffer.from(hkdfSync('sha256', noteKey, hkdfSalt, info, 32));

  const key = expand(Buffer.concat([LIVE_COLLAB_KEY_INFO, epochBytes, uid]));
  // An HKDF block can fall outside the valid scalar range; the Rust side
  // retries with a counter, so this does too.
  for (let counter = 0; counter < 256; counter++) {
    const scalar = expand(
      Buffer.concat([
        LIVE_COLLAB_JOIN_INFO,
        epochBytes,
        uid,
        Buffer.from([counter])
      ])
    );
    let privateKey;
    try {
      privateKey = createPrivateKey({
        key: Buffer.concat([P256_PKCS8_PREFIX, scalar]),
        format: 'der',
        type: 'pkcs8'
      });
    } catch {
      continue;
    }
    const roomId = createPublicKey(privateKey)
      .export({ type: 'spki', format: 'der' })
      .toString('base64');
    return { roomId, key, privateKey };
  }
  throw new Error('derive join key: no valid scalar in 256 attempts');
}

/** A room nobody else knows, for scenarios that only exercise the relay. */
export function randomRoom() {
  return deriveRoom({
    noteUid: randomBytes(16).toString('hex'),
    noteKey: randomBytes(32),
    salt: null,
    epoch: 0
  });
}

/** `getYjsRelayUrl` in src/lib/api/server-urls.ts. */
export function relayUrl(serverUrl) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/yjs`;
  return url.toString();
}

/** One member of a room, on either transport. */
class Peer {
  constructor(sendFrame, close) {
    this.send = sendFrame;
    this.close = close;
    this.inbox = [];
    this.waiters = [];
  }

  deliver(frame) {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(frame);
    else this.inbox.push(frame);
  }

  nextFrame(timeoutMs = FRAME_TIMEOUT_MS) {
    if (this.inbox.length > 0) return Promise.resolve(this.inbox.shift());
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        }
      };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`no frame within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

/** Connect to a yjs-relay room and answer its join challenge. */
export function joinRoom(url, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}?room=${encodeURIComponent(room.roomId)}`);
    const peer = new Peer(
      (frame) => ws.send(frame),
      () => ws.terminate()
    );
    let joined = false;
    const fail = (reason) => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error(`relay join failed: ${reason}`));
    };
    const timer = setTimeout(() => fail('no join challenge'), FRAME_TIMEOUT_MS);

    ws.on('message', (frame) => {
      if (joined) {
        peer.deliver(frame);
        return;
      }
      const isChallenge =
        frame.length === HANDSHAKE.length + NONCE_LEN &&
        frame.subarray(0, HANDSHAKE.length).equals(HANDSHAKE);
      if (!isChallenge) return;
      const signature = sign(
        'sha256',
        Buffer.concat([
          JOIN_CONTEXT,
          Buffer.from(room.roomId, 'utf8'),
          frame.subarray(HANDSHAKE.length)
        ]),
        { key: room.privateKey, dsaEncoding: 'ieee-p1363' }
      );
      ws.send(Buffer.concat([HANDSHAKE, signature]));
      // The relay sends no acknowledgement. Frames written after the answer
      // are processed after it, so the caller may send straight away.
      joined = true;
      clearTimeout(timer);
      resolve(peer);
    });
    ws.on('error', (err) => fail(err.message));
    ws.on('close', (code) => {
      if (!joined) fail(`closed with ${code}`);
    });
  });
}

/** Join an excalidraw-room room over socket.io, as `ExcalidrawRoomClient` does. */
export function joinExcalidrawRoom(serverUrl, roomId) {
  return new Promise((resolve, reject) => {
    const socket = io(serverUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });
    const peer = new Peer(
      (frame) =>
        socket.emit('server-broadcast', roomId, frame, randomBytes(12)),
      () => socket.disconnect()
    );
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('excalidraw-room did not admit the client'));
    }, FRAME_TIMEOUT_MS);

    socket.on('init-room', () => socket.emit('join-room', roomId));
    // Sent to the whole room once the server has added this socket to it.
    socket.once('room-user-change', () => {
      clearTimeout(timer);
      resolve(peer);
    });
    socket.on('client-broadcast', (frame) => peer.deliver(frame));
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`excalidraw-room connect failed: ${err.message}`));
    });
  });
}

/**
 * Wait until every peer receives what the first one sends. Neither server
 * acknowledges a join, and a frame published before a peer is subscribed is
 * simply not delivered to it, so measuring without this races the join.
 */
export async function settle(peers) {
  const [sender, ...receivers] = peers;
  await Promise.all(
    receivers.map(async (receiver) => {
      for (let attempt = 0; ; attempt++) {
        sender.send(randomBytes(16));
        try {
          await receiver.nextFrame(250);
          return;
        } catch (err) {
          if (attempt === 40) throw err;
        }
      }
    })
  );
  // Let the surplus probes land, then discard them.
  await new Promise((done) => setTimeout(done, 300));
  for (const peer of peers) peer.inbox.length = 0;
}

/** Latency of one frame from the first peer to all the others, `count` times. */
export async function roundTrips(peers, frameBytes, count) {
  const [sender, ...receivers] = peers;
  const latencies = [];
  for (let i = 0; i < count; i++) {
    const frame = randomBytes(frameBytes);
    const started = performance.now();
    sender.send(frame);
    await Promise.all(receivers.map((receiver) => receiver.nextFrame()));
    latencies.push(performance.now() - started);
  }
  return latencies;
}

/** Frames per second the server delivers when the sender doesn't wait. */
export async function throughput(sender, receiver, frameBytes, count) {
  const frame = randomBytes(frameBytes);
  const started = performance.now();
  for (let i = 0; i < count; i++) sender.send(frame);
  for (let i = 0; i < count; i++) await receiver.nextFrame();
  return count / ((performance.now() - started) / 1000);
}
