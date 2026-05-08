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
 * Run:
 *   node backend/yjs-collab/collab-server.mjs           # binds 0.0.0.0:1234
 *   PORT=8080 HOST=127.0.0.1 node ...        # override
 *
 * Behind a reverse proxy (recommended), terminate TLS at the proxy and
 * point clients at `wss://...`. Direct exposure works for trusted LANs.
 *
 * Dependencies: just `ws`. Install with `npm i ws`.
 */

import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 1234);
const HOST = process.env.HOST ?? '0.0.0.0';

/** room id (string) -> Set<WebSocket> */
const rooms = new Map();

const wss = new WebSocketServer({ host: HOST, port: PORT });

wss.on('connection', (ws, req) => {
  // Pull room from the query string. The client encodes it via
  // encodeURIComponent on the etebase Item UID.
  const url = new URL(req.url ?? '/', 'http://localhost');
  const room = url.searchParams.get('room');
  if (!room) {
    ws.close(1008, 'missing room param');
    return;
  }

  let peers = rooms.get(room);
  if (!peers) {
    peers = new Set();
    rooms.set(room, peers);
  }
  peers.add(ws);

  ws.on('message', (data) => {
    // Broadcast to every other client in this room. We send the payload
    // as-is (binary frame, opaque ciphertext); ws preserves the type.
    for (const peer of peers) {
      if (peer === ws) continue;
      if (peer.readyState !== ws.OPEN) continue;
      try {
        peer.send(data);
      } catch (err) {
        // Don't let one bad peer take down the broadcast.
        console.warn('[collab] send failed:', err?.message ?? err);
      }
    }
  });

  ws.on('close', () => {
    peers.delete(ws);
    if (peers.size === 0) rooms.delete(room);
  });

  ws.on('error', (err) => {
    console.warn('[collab] ws error:', err?.message ?? err);
  });
});

wss.on('listening', () => {
  console.log(`[collab] relay listening on ws://${HOST}:${PORT}`);
});

wss.on('error', (err) => {
  console.error('[collab] server error:', err);
  process.exit(1);
});
