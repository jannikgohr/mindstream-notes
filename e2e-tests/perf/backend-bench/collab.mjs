/**
 * Live-collaboration transports: the yjs-relay (markdown, PDF, kanban, ink)
 * and excalidraw-room (freeform).
 *
 * How a client proves it may enter a room differs by server, so the
 * scenarios work through a transport: `relayTransport` for the yjs-relay,
 * where the room id is the public half of a keypair derived from the note
 * key and the client signs a nonce with the private half, and
 * `roomsTransport` for a server with built-in rooms, where the client
 * presents a ticket the server issued to its session.
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
function deriveRoom({ noteUid, noteKey, salt, epoch }) {
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
function randomRoom() {
  return deriveRoom({
    noteUid: randomBytes(16).toString('hex'),
    noteKey: randomBytes(32),
    salt: null,
    epoch: 0
  });
}

/** `getYjsRelayUrl` in src/lib/api/server-urls.ts. */
function relayUrl(serverUrl) {
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
function joinRoom(url, room) {
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

// Frame kinds of the built-in rooms (backend/server/src/hub.rs).
const FRAME_HELLO = 0x01;
const FRAME_WELCOME = 0x02;
const CLASS_UPDATE = 0x10;
/** A relayed frame is its class, the sender's 4-byte id, then the payload. */
const RELAYED_HEADER = 5;

/** Enter a room on a server with built-in rooms, using a ticket. */
function enterRoom(serverUrl, ticket) {
  return new Promise((resolve, reject) => {
    const url = new URL(serverUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/v1/room/`;
    const ws = new WebSocket(url.toString());
    const peer = new Peer(
      (frame) => ws.send(Buffer.concat([Buffer.from([CLASS_UPDATE]), frame])),
      () => ws.terminate()
    );
    let welcomed = false;
    const fail = (reason) => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error(`room join failed: ${reason}`));
    };
    const timer = setTimeout(() => fail('no welcome'), FRAME_TIMEOUT_MS);

    ws.on('open', () =>
      ws.send(Buffer.concat([Buffer.from([FRAME_HELLO]), Buffer.from(ticket)]))
    );
    ws.on('message', (frame) => {
      if (frame[0] === FRAME_WELCOME) {
        welcomed = true;
        clearTimeout(timer);
        resolve(peer);
      } else if (frame[0] >= CLASS_UPDATE) {
        peer.deliver(frame.subarray(RELAYED_HEADER));
      }
      // Other control frames are roster news, which no scenario reads.
    });
    ws.on('error', (err) => fail(err.message));
    ws.on('close', (code) => {
      if (!welcomed) fail(`closed with ${code}`);
    });
  });
}

/**
 * The yjs-relay. A room is derived from a note key and needs nothing from
 * the server to exist.
 */
export function relayTransport(serverUrl) {
  const url = relayUrl(serverUrl);
  return {
    joinDetail: 'relay: connect, join challenge, first frame delivered',
    newRoom: async () => randomRoom(),
    noteRoom: (info) => deriveRoom(info),
    join: (room) => joinRoom(url, room)
  };
}

/**
 * Rooms built into the server. A room is an item in a collection, and
 * entering takes a ticket requested over the device's session.
 *
 * @param device The device whose session asks for tickets.
 * @param newItem Creates and pushes an item, returning its collection and
 *   item uids, for scenarios that need a room nobody else is in.
 */
export function roomsTransport(device, newItem) {
  return {
    joinDetail: 'rooms: ticket, connect, first frame delivered',
    newRoom: newItem,
    noteRoom: (info) => ({
      collectionUid: info.collectionUid,
      itemUid: info.noteUid
    }),
    join: async (room) =>
      enterRoom(
        device.serverUrl,
        await device.roomTicket(room.collectionUid, room.itemUid)
      )
  };
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
