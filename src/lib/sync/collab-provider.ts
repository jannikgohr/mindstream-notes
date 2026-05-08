/**
 * E2EE collab provider for live yjs co-editing.
 *
 * Why custom (vs y-websocket directly): vanilla y-websocket carries
 * y.js update bytes in plaintext, so a self-hosted relay would see
 * everything users type. We want the relay to be a dumb broadcast hub
 * that only sees ciphertext — so this provider AES-GCM-encrypts every
 * outgoing payload with a per-note 32-byte key and decrypts incoming
 * frames before applying. The room key is distributed via etebase
 * (already E2EE), see src-tauri/src/sync/mod.rs::NotePayload.
 *
 * Wire frame layout (all binary, no JSON):
 *   [1 byte type][12 bytes IV][N bytes ciphertext+gcm-tag]
 *
 * Type byte:
 *   0x00 sync_step_1  — sender's encoded state vector. Peer responds
 *                       with sync_step_2 carrying the missing updates.
 *   0x01 sync_step_2  — encoded yjs update bytes. Apply to local doc.
 *   0x02 awareness    — encoded awareness update (cursors/presence).
 *
 * Server contract: receive a frame from client X in room R, broadcast
 * to every other client in R. No state, no peeking. See
 * scripts/collab-server.mjs for a 50-line reference impl.
 */

import * as Y from 'yjs';
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  type Awareness
} from 'y-protocols/awareness';

const FRAME_SYNC_STEP_1 = 0x00;
const FRAME_SYNC_STEP_2 = 0x01;
const FRAME_AWARENESS = 0x02;
const IV_LEN = 12;

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** First/last few base64 chars of the key — enough to confirm two
 *  devices imported the same secret without leaking the secret. */
function keyFingerprint(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  const b64 = btoa(bin);
  return `${b64.slice(0, 3)}…${b64.slice(-3)}`;
}

function frameName(type: number): string {
  switch (type) {
    case FRAME_SYNC_STEP_1:
      return 'sync_step_1';
    case FRAME_SYNC_STEP_2:
      return 'sync_step_2';
    case FRAME_AWARENESS:
      return 'awareness';
    default:
      return `unknown(0x${type.toString(16)})`;
  }
}

export interface CollabProviderOptions {
  /** wss:// URL of the relay. */
  url: string;
  /** Room ID — we use the etebase Item UID. */
  roomId: string;
  /** 32 raw bytes of AES-GCM key material. */
  keyBytes: Uint8Array;
  /** Live yjs document the editor is bound to. */
  doc: Y.Doc;
  /** Awareness instance for cursor + presence. */
  awareness: Awareness;
  /** Optional callback fired on connect / disconnect (for UI badges). */
  onStatusChange?: (online: boolean) => void;
}

export class CollabProvider {
  private ws: WebSocket | null = null;
  private cryptoKey: CryptoKey | null = null;
  private destroyed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly docUpdateHandler: (
    update: Uint8Array,
    origin: unknown
  ) => void;
  private readonly awarenessUpdateHandler: (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => void;

  constructor(private readonly opts: CollabProviderOptions) {
    // Local doc edits → encrypt + send. `origin === this` filters out
    // the updates we just *received* (we re-applied them with origin=this
    // in handleMessage), preventing an echo loop.
    this.docUpdateHandler = (update, origin) => {
      if (origin === this) return;
      void this.send(FRAME_SYNC_STEP_2, update);
    };
    this.awarenessUpdateHandler = ({ added, updated, removed }, origin) => {
      if (origin === this) return;
      const changedClients = [...added, ...updated, ...removed];
      if (changedClients.length === 0) return;
      const update = encodeAwarenessUpdate(this.opts.awareness, changedClients);
      void this.send(FRAME_AWARENESS, update);
    };

    this.opts.doc.on('update', this.docUpdateHandler);
    this.opts.awareness.on('update', this.awarenessUpdateHandler);

    console.info(
      '[collab] init room=%s key=%s url=%s',
      this.opts.roomId,
      keyFingerprint(this.opts.keyBytes),
      this.opts.url
    );
    void this.connect();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.opts.doc.off('update', this.docUpdateHandler);
    this.opts.awareness.off('update', this.awarenessUpdateHandler);
    // Drop our own awareness state so peers' cursor list immediately
    // reflects the disconnect — the relay's broadcast of a final null
    // state happens before we close the socket below.
    try {
      this.opts.awareness.setLocalState(null);
    } catch {
      /* ignore */
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.opts.onStatusChange?.(false);
  }

  private async connect(): Promise<void> {
    if (this.destroyed) return;
    if (!this.cryptoKey) {
      this.cryptoKey = await crypto.subtle.importKey(
        'raw',
        this.opts.keyBytes.slice().buffer,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
      );
    }
    if (this.destroyed) return;
    const url = `${this.opts.url}?room=${encodeURIComponent(this.opts.roomId)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.warn('[collab] WebSocket constructor threw:', err);
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.opts.onStatusChange?.(true);
      console.info('[collab] open room=%s', this.opts.roomId);
      // Initial sync handshake: send our state vector so peers already in
      // the room can compute a diff and ship us their newer ops.
      const sv = Y.encodeStateVector(this.opts.doc);
      void this.send(FRAME_SYNC_STEP_1, sv);
      // Announce our awareness so peers' cursor list shows us joining.
      const local = encodeAwarenessUpdate(this.opts.awareness, [
        this.opts.awareness.clientID
      ]);
      void this.send(FRAME_AWARENESS, local);
    };
    ws.onmessage = (e) => {
      void this.handleMessage(e.data);
    };
    ws.onclose = (e) => {
      this.ws = null;
      this.opts.onStatusChange?.(false);
      console.info(
        '[collab] close room=%s code=%d reason=%s',
        this.opts.roomId,
        e.code,
        e.reason || '(none)'
      );
      this.scheduleReconnect();
    };
    ws.onerror = (e) => {
      console.warn('[collab] error room=%s', this.opts.roomId, e);
      // onclose will fire next; reconnect logic lives there.
    };
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_INITIAL_MS * 2 ** this.reconnectAttempt
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private async send(type: number, payload: Uint8Array): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.debug(
        '[collab] send dropped (ws not open) %s payload=%dB',
        frameName(type),
        payload.byteLength
      );
      return;
    }
    if (!this.cryptoKey) return;
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    // TS 5.7's lib.dom.d.ts narrowed BufferSource to require
    // `Uint8Array<ArrayBuffer>` rather than the looser ArrayBufferLike.
    // Materialise a fresh ArrayBuffer via slice() to satisfy that — at
    // runtime any Uint8Array is a valid BufferSource, but the compiler
    // can't see that without the copy.
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv.slice().buffer },
        this.cryptoKey,
        payload.slice().buffer
      )
    );
    const frame = new Uint8Array(1 + IV_LEN + ct.byteLength);
    frame[0] = type;
    frame.set(iv, 1);
    frame.set(ct, 1 + IV_LEN);
    try {
      ws.send(frame);
      console.debug(
        '[collab] send %s payload=%dB frame=%dB',
        frameName(type),
        payload.byteLength,
        frame.byteLength
      );
    } catch (err) {
      console.warn('[collab] send failed:', err);
    }
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (!(data instanceof ArrayBuffer)) return;
    if (!this.cryptoKey) return;
    const frame = new Uint8Array(data);
    if (frame.byteLength < 1 + IV_LEN) return;
    const type = frame[0];
    const iv = frame.subarray(1, 1 + IV_LEN);
    const ct = frame.subarray(1 + IV_LEN);
    let pt: Uint8Array;
    try {
      pt = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: iv.slice().buffer },
          this.cryptoKey,
          ct.slice().buffer
        )
      );
    } catch (err) {
      // Wrong key, malformed ciphertext, or replay from a different
      // room — drop loudly so the user can spot key mismatches when
      // diagnosing "live editing not working." A genuinely broken peer
      // will keep failing and the badge will stay offline.
      console.warn(
        '[collab] decrypt failed type=%s frame=%dB room=%s — likely a key mismatch between devices',
        frameName(type),
        frame.byteLength,
        this.opts.roomId,
        err
      );
      return;
    }
    console.debug(
      '[collab] recv %s payload=%dB frame=%dB',
      frameName(type),
      pt.byteLength,
      frame.byteLength
    );
    switch (type) {
      case FRAME_SYNC_STEP_1: {
        // Peer sent their state vector. Reply with the diff they're missing.
        const diff = Y.encodeStateAsUpdate(this.opts.doc, pt);
        void this.send(FRAME_SYNC_STEP_2, diff);
        break;
      }
      case FRAME_SYNC_STEP_2:
        // origin=this so the docUpdateHandler doesn't echo this update
        // back out as if it were a local edit.
        Y.applyUpdate(this.opts.doc, pt, this);
        break;
      case FRAME_AWARENESS:
        applyAwarenessUpdate(this.opts.awareness, pt, this);
        break;
      default:
        console.warn('[collab] unknown frame type', type);
    }
  }
}
