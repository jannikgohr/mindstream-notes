/**
 * Client half of the yjs-relay join challenge, for backend e2e specs.
 *
 * Mirrors src/lib/sync/collab-join-challenge.ts, but deliberately
 * reimplemented rather than imported: these specs are meant to hold the
 * *protocol* still. If the app's implementation drifts, the spec should fail
 * rather than drift with it.
 *
 * See backend/yjs-relay/collab-server.mjs for the relay side.
 */

import { webcrypto } from 'node:crypto';
import WebSocket from 'ws';

export const HANDSHAKE_MARKER = 0xfe;
export const HANDSHAKE_VERSION = 0x01;
export const NONCE_LEN = 32;
const JOIN_CONTEXT = Buffer.from('mindstream-collab-join/v1', 'utf8');

export interface RoomKeys {
  /** Base64 P-256 SPKI — the room id the relay verifies against. */
  room: string;
  privateKey: CryptoKey;
}

/** A room is named after the public half of a keypair. */
export async function makeRoom(): Promise<RoomKeys> {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const spki = Buffer.from(
    await webcrypto.subtle.exportKey('spki', pair.publicKey)
  );
  return { room: spki.toString('base64'), privateKey: pair.privateKey };
}

export async function signChallenge(
  room: string,
  privateKey: CryptoKey,
  nonce: Buffer
): Promise<Buffer> {
  const signature = Buffer.from(
    await webcrypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      Buffer.concat([JOIN_CONTEXT, Buffer.from(room, 'utf8'), nonce])
    )
  );
  return Buffer.concat([
    Buffer.from([HANDSHAKE_MARKER, HANDSHAKE_VERSION]),
    signature
  ]);
}

export interface RelayPeer {
  ws: WebSocket;
  /** Data frames received *after* the challenge. */
  readonly data: Buffer[];
  /** The challenge nonce, once the relay sends one. */
  readonly challenge: Buffer | null;
  /** Close code + reason, once closed. */
  readonly closed: { code: number; reason: string } | null;
  /** Resolves on first challenge, or on close — whichever comes first. */
  settled: Promise<void>;
  close(): void;
}

/**
 * Connect to a room. `answer` decides what to send when challenged: return a
 * Buffer to reply, or null to stay silent.
 */
export function connectPeer(
  baseUrl: string,
  room: string,
  answer: (nonce: Buffer) => Promise<Buffer | null> | Buffer | null
): RelayPeer {
  const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/yjs?room=${encodeURIComponent(room)}`;
  const ws = new WebSocket(wsUrl);
  const state: {
    data: Buffer[];
    challenge: Buffer | null;
    closed: { code: number; reason: string } | null;
  } = { data: [], challenge: null, closed: null };

  const settled = new Promise<void>((resolve) => {
    ws.on('message', async (raw: Buffer) => {
      const frame = Buffer.from(raw);
      const isChallenge =
        frame.length === 2 + NONCE_LEN &&
        frame[0] === HANDSHAKE_MARKER &&
        frame[1] === HANDSHAKE_VERSION;
      if (isChallenge && !state.challenge) {
        state.challenge = frame.subarray(2);
        const reply = await answer(state.challenge);
        if (reply && ws.readyState === WebSocket.OPEN) ws.send(reply);
        resolve();
        return;
      }
      state.data.push(frame);
    });
    ws.on('close', (code, reason) => {
      state.closed = { code, reason: reason.toString() };
      resolve();
    });
    ws.on('error', () => resolve());
  });

  return {
    ws,
    get data() {
      return state.data;
    },
    get challenge() {
      return state.challenge;
    },
    get closed() {
      return state.closed;
    },
    settled,
    close() {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }
  };
}

export const wait = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
