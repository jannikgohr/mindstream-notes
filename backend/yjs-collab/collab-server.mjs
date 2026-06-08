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
 */

import uWS from 'uWebSockets.js';

const PORT = Number(process.env.PORT ?? 1234);
const HOST = process.env.HOST ?? '0.0.0.0';

const MAX_PAYLOAD_LENGTH = 16 * 1024 * 1024;
// Drop peers whose outbound queue grows past this. Frames are encrypted
// ciphertext, so we can't coalesce or merge a slow consumer's backlog —
// disconnecting and letting the client resync is the cleanest option.
const MAX_BACKPRESSURE_BYTES = 4 * 1024 * 1024; // 4 MiB

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
    // matches the client's encodeURIComponent on the etebase Item UID.
    const room = new URLSearchParams(query).get('room');
    if (!room) {
      res.writeStatus('400 Bad Request').end('missing room param');
      return;
    }
    res.upgrade(
      { room },
      req.getHeader('sec-websocket-key'),
      req.getHeader('sec-websocket-protocol'),
      req.getHeader('sec-websocket-extensions'),
      context
    );
  },

  open: (ws) => {
    // uWS pub/sub fans out natively in C++ and ws.publish() skips the
    // sender, so we no longer iterate a JS Set per inbound frame.
    ws.subscribe(ws.room);
  },

  message: (ws, message, isBinary) => {
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
