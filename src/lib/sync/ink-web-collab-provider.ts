/**
 * E2EE live-collab provider for desktop web ink notes.
 *
 * This mirrors the frame protocol used by `$lib/sync/collab-provider`
 * and `src-tauri/src/drawing/collab.rs`, but delegates all Yjs document
 * operations to the handle supplied by `InkWebNoteEditor`. JS only
 * encrypts, decrypts, and routes update bytes.
 */

import {
  canSignCollabFrame,
  decodeCollabFrame,
  encodeCollabFrame,
  signedCollabFrameNeedsAuthRefresh,
  type CollabFrameAuth
} from './signed-collab-frame';

const FRAME_SYNC_STEP_1 = 0x00;
const FRAME_SYNC_STEP_2 = 0x01;
const FRAME_AWARENESS = 0x02;
const SIGNED_REQUIRED_TYPES = new Set([FRAME_SYNC_STEP_2]);

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const AUTH_REFRESH_THROTTLE_MS = 5_000;

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

function roomUrl(url: string, roomId: string): string {
  const lowerUrl = url.toLowerCase();
  const websocketUrl = lowerUrl.startsWith('http://')
    ? `ws://${url.slice('http://'.length)}`
    : lowerUrl.startsWith('https://')
      ? `wss://${url.slice('https://'.length)}`
      : url;
  const separator = websocketUrl.includes('?')
    ? websocketUrl.endsWith('?') || websocketUrl.endsWith('&')
      ? ''
      : '&'
    : '?';
  return `${websocketUrl}${separator}room=${encodeURIComponent(roomId)}`;
}

export interface InkWebCollabHandle {
  encode_state_vector(): Uint8Array;
  encode_diff_for_state_vector(stateVector: Uint8Array): Uint8Array;
  apply_remote_update(update: Uint8Array): boolean;
}

export interface InkWebCollabProviderOptions {
  url: string;
  roomId: string;
  keyBytes: Uint8Array;
  handle: InkWebCollabHandle;
  noteId: string;
  onStatusChange?: (online: boolean) => void;
  auth?: CollabFrameAuth;
  onAuthStale?: () => void;
}

export class InkWebCollabProvider {
  private ws: WebSocket | null = null;
  private cryptoKey: CryptoKey | null = null;
  private destroyed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAuthRefreshRequest = 0;

  constructor(private readonly opts: InkWebCollabProviderOptions) {
    console.info(
      '[ink-collab] init note=%s room=resolved key=present url=configured',
      this.opts.noteId
    );
    void this.connect();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
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

  sendLocalUpdate(update: Uint8Array): void {
    if (update.byteLength === 0) return;
    if (this.opts.auth && !canSignCollabFrame(this.opts.auth)) return;
    console.debug(
      '[ink-collab] enqueue local update note=%s payload=%dB',
      this.opts.noteId,
      update.byteLength
    );
    void this.send(FRAME_SYNC_STEP_2, update);
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

    const url = roomUrl(this.opts.url, this.opts.roomId);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.warn(
        '[ink-collab] WebSocket constructor threw note=%s',
        this.opts.noteId
      );
      this.scheduleReconnect();
      return;
    }

    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.opts.onStatusChange?.(true);
      console.info('[ink-collab] open note=%s', this.opts.noteId);
      const sv = this.opts.handle.encode_state_vector();
      void this.send(FRAME_SYNC_STEP_1, sv);
    };
    ws.onmessage = (e) => {
      void this.handleMessage(e.data);
    };
    ws.onclose = (e) => {
      this.ws = null;
      this.opts.onStatusChange?.(false);
      console.info(
        '[ink-collab] close note=%s code=%d reason=%s',
        this.opts.noteId,
        e.code,
        e.reason || '(none)'
      );
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      console.warn('[ink-collab] error note=%s', this.opts.noteId);
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
        '[ink-collab] send dropped (ws not open) note=%s %s payload=%dB',
        this.opts.noteId,
        frameName(type),
        payload.byteLength
      );
      return;
    }
    if (!this.cryptoKey) return;

    const frame = await encodeCollabFrame(
      type,
      payload,
      this.cryptoKey,
      this.opts.auth
    );
    if (this.destroyed || ws.readyState !== WebSocket.OPEN) return;

    try {
      ws.send(frame);
      console.debug(
        '[ink-collab] send %s note=%s payload=%dB frame=%dB',
        frameName(type),
        this.opts.noteId,
        payload.byteLength,
        frame.byteLength
      );
    } catch (err) {
      console.warn('[ink-collab] send failed:', err);
    }
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (!(data instanceof ArrayBuffer)) return;
    if (!this.cryptoKey) return;
    const frame = new Uint8Array(data);

    let decoded;
    try {
      decoded = await decodeCollabFrame(
        frame,
        this.cryptoKey,
        this.opts.auth,
        SIGNED_REQUIRED_TYPES
      );
    } catch (err) {
      console.warn(
        '[ink-collab] decrypt failed type=%s frame=%dB note=%s - likely a key mismatch between devices',
        frameName(frame[0]),
        frame.byteLength,
        this.opts.noteId,
        err
      );
      return;
    }
    if (!decoded) {
      this.maybeRequestAuthRefresh(frame);
      return;
    }
    const { type, payload: pt } = decoded;
    if (this.destroyed) return;

    console.debug(
      '[ink-collab] recv %s note=%s payload=%dB frame=%dB',
      frameName(type),
      this.opts.noteId,
      pt.byteLength,
      frame.byteLength
    );
    switch (type) {
      case FRAME_SYNC_STEP_1: {
        const diff = this.opts.handle.encode_diff_for_state_vector(pt);
        void this.send(FRAME_SYNC_STEP_2, diff);
        break;
      }
      case FRAME_SYNC_STEP_2: {
        const applied = this.opts.handle.apply_remote_update(pt);
        console.debug(
          '[ink-collab] remote update %s note=%s payload=%dB',
          applied ? 'applied' : 'failed',
          this.opts.noteId,
          pt.byteLength
        );
        break;
      }
      case FRAME_AWARENESS:
        break;
      default:
        console.warn('[ink-collab] unknown frame type', type);
    }
  }

  private maybeRequestAuthRefresh(frame: Uint8Array): void {
    if (!signedCollabFrameNeedsAuthRefresh(frame, this.opts.auth)) return;
    const now = Date.now();
    if (now - this.lastAuthRefreshRequest < AUTH_REFRESH_THROTTLE_MS) return;
    this.lastAuthRefreshRequest = now;
    console.info(
      '[ink-collab] refreshing writer auth note=%s',
      this.opts.noteId
    );
    this.opts.onAuthStale?.();
  }
}
