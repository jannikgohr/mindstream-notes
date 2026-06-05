/**
 * E2EE live-collab provider for desktop web ink notes.
 *
 * This mirrors the frame protocol used by `$lib/sync/collab-provider`
 * and `src-tauri/src/drawing/collab.rs`, but keeps all Yrs document
 * operations inside the `ink-egui-web` WASM handle. JS only encrypts,
 * decrypts, and routes update bytes.
 */

const FRAME_SYNC_STEP_1 = 0x00;
const FRAME_SYNC_STEP_2 = 0x01;
const FRAME_AWARENESS = 0x02;
const IV_LEN = 12;

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

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
}

export class InkWebCollabProvider {
  private ws: WebSocket | null = null;
  private cryptoKey: CryptoKey | null = null;
  private destroyed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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

    const url = `${this.opts.url}?room=${encodeURIComponent(this.opts.roomId)}`;
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

    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
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
      console.warn(
        '[ink-collab] decrypt failed type=%s frame=%dB note=%s - likely a key mismatch between devices',
        frameName(type),
        frame.byteLength,
        this.opts.noteId,
        err
      );
      return;
    }
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
}
