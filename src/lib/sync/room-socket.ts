/**
 * A connection to a note's live room on the sync server.
 *
 * A room is the note's item on the server. Getting in takes a ticket, which
 * the Rust side asks for with the session and hands over; this module never
 * sees the session token. Once in, the server tells us who else is there and
 * with what access, and it drops document changes from members who may only
 * read. That is what the join challenge, the writer-key registry and the
 * per-frame signatures used to do from the outside.
 *
 * What stays ours is the content. Every payload is AES-GCM-encrypted under a
 * key derived from the note's own, which the server never has. It relays
 * ciphertext.
 *
 * Client to server:
 *   [0x01 hello][ticket, utf-8]                  first frame
 *   [class][12-byte IV][ciphertext]              to everyone else
 *   [0x12 reply][target, u32 BE][IV][ciphertext] to one member
 *
 * Server to client:
 *   [0x02 welcome | 0x03 joined | 0x04 left | 0x05 access][JSON]
 *   [class][sender, u32 BE][12-byte IV][ciphertext]
 *
 * The class sits outside the ciphertext so the server can decide who may
 * send it, and it is bound into the encryption so a payload cannot be
 * replayed under another class. A receiver acts on the class the server
 * relayed, never on anything inside the payload: that is what stops a
 * read-only member from passing a document change off as presence.
 */

const FRAME_HELLO = 0x01;
const FRAME_WELCOME = 0x02;
const FRAME_JOINED = 0x03;
const FRAME_LEFT = 0x04;
const FRAME_ACCESS = 0x05;

/** A change to the document. Needs write access. */
export const ROOM_CLASS_UPDATE = 0x10;
/** A request for the document's state, sent on joining. */
export const ROOM_CLASS_SYNC = 0x11;
/** An answer to one member's request. Carries document state, so it needs
 *  write access too. */
export const ROOM_CLASS_REPLY = 0x12;
/** Cursors and the like. Never stored, never part of the document. */
export const ROOM_CLASS_PRESENCE = 0x20;

export const ROOM_ACCESS_READ_ONLY = 0;

const IV_BYTES = 12;
const SENDER_BYTES = 4;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface RoomPeer {
  /** The server's name for one socket. A person with two devices in the
   *  room is two peers. */
  id: number;
  /** The account the server authenticated, not something the peer claims. */
  username: string;
  accessLevel: number;
}

export interface RoomFrame {
  /** One of the ROOM_CLASS_* constants, as the server relayed it. */
  cls: number;
  /** The peer that sent it. */
  sender: number;
  /** The decrypted payload. */
  payload: Uint8Array;
}

/** What it takes to reach a room. The Rust side supplies all of it. */
export interface RoomConnection {
  /** ws:// or wss:// address of the server's room endpoint. */
  url: string;
  /** 32 raw bytes of AES-GCM key material. */
  keyBytes: Uint8Array;
  /**
   * A fresh ticket for each attempt to connect: a ticket is good for one
   * socket and about half a minute. Resolving `null` means the server will
   * not let this account in, and the socket stops trying. Rejecting means
   * "could not ask", which is retried.
   */
  getTicket: () => Promise<string | null>;
}

export interface RoomSocketOptions extends RoomConnection {
  /** Names the room in logs. */
  label?: string;
  /** In the room, and told who else is. The moment to start syncing. */
  onOpen?: () => void;
  onFrame: (frame: RoomFrame) => void;
  /** A peer's socket closed. */
  onPeerLeft?: (id: number) => void;
  onPeersChange?: (peers: RoomPeer[]) => void;
  onStatusChange?: (online: boolean) => void;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function isPeer(value: unknown): value is RoomPeer {
  const peer = value as RoomPeer;
  return (
    typeof peer === 'object' &&
    peer !== null &&
    Number.isInteger(peer.id) &&
    typeof peer.username === 'string' &&
    Number.isInteger(peer.accessLevel)
  );
}

export class RoomSocket {
  private ws: WebSocket | null = null;
  private cryptoKey: CryptoKey | null = null;
  private destroyed = false;
  private refused = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** True between the server's welcome and the socket closing. */
  private joined = false;
  private selfId: number | null = null;
  private accessLevel = ROOM_ACCESS_READ_ONLY;
  private readonly roster = new Map<number, RoomPeer>();

  constructor(private readonly opts: RoomSocketOptions) {
    void this.connect();
  }

  /** Whether the server lets this member change the document right now. */
  get canWrite(): boolean {
    return this.joined && this.accessLevel !== ROOM_ACCESS_READ_ONLY;
  }

  /** Everyone else in the room. */
  get peers(): RoomPeer[] {
    return [...this.roster.values()];
  }

  /** Whether a peer could answer a request for the document's state. A peer
   *  we know nothing about counts as able to. */
  peerCanWrite(id: number): boolean {
    return this.roster.get(id)?.accessLevel !== ROOM_ACCESS_READ_ONLY;
  }

  /** Send to everyone else in the room. Dropped when not connected. */
  send(cls: number, payload: Uint8Array): Promise<void> {
    return this.transmit(cls, null, payload);
  }

  /** Answer one member, usually the one who just asked for the state. */
  reply(target: number, payload: Uint8Array): Promise<void> {
    return this.transmit(ROOM_CLASS_REPLY, target, payload);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    this.leave();
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  }

  private label(): string {
    return this.opts.label ?? 'room';
  }

  private async connect(): Promise<void> {
    if (this.destroyed || this.refused) return;
    try {
      this.cryptoKey ??= await crypto.subtle.importKey(
        'raw',
        this.opts.keyBytes.slice().buffer,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
      );
    } catch (err) {
      // A key that does not import will not import next time either.
      console.warn('[room] key import failed %s', this.label(), err);
      this.refused = true;
      return;
    }

    let ticket: string | null;
    try {
      ticket = await this.opts.getTicket();
    } catch (err) {
      console.debug('[room] could not ask for a ticket %s', this.label(), err);
      this.scheduleReconnect();
      return;
    }
    if (this.destroyed) return;
    if (ticket === null) {
      // Not a member, the note is gone, or the session is over. Asking
      // again gets the same answer.
      console.info('[room] entry refused %s', this.label());
      this.refused = true;
      return;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (err) {
      console.warn('[room] WebSocket constructor threw:', err);
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      // The ticket goes first and alone. Nothing else is sent until the
      // server has welcomed us.
      ws.send(
        concat(Uint8Array.of(FRAME_HELLO), new TextEncoder().encode(ticket))
      );
    };
    ws.onmessage = (event) => {
      void this.handleMessage(ws, event.data);
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.leave();
      console.info(
        '[room] close %s code=%d reason=%s',
        this.label(),
        event.code,
        event.reason || '(none)'
      );
      // Whatever the reason, the way back is a new ticket. If we were
      // removed or signed out, asking for one is what says so.
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose fires next; reconnecting lives there.
    };
  }

  /** Forget the room: nobody is in it as far as we can tell. */
  private leave(): void {
    const wasJoined = this.joined;
    this.joined = false;
    this.selfId = null;
    this.accessLevel = ROOM_ACCESS_READ_ONLY;
    if (this.roster.size > 0) {
      const gone = [...this.roster.keys()];
      this.roster.clear();
      for (const id of gone) this.opts.onPeerLeft?.(id);
      this.opts.onPeersChange?.([]);
    }
    if (wasJoined) this.opts.onStatusChange?.(false);
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.refused || this.reconnectTimer !== null) return;
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

  private async transmit(
    cls: number,
    target: number | null,
    payload: Uint8Array
  ): Promise<void> {
    const ws = this.ws;
    const key = this.cryptoKey;
    if (!ws || !key || !this.joined || ws.readyState !== WebSocket.OPEN) return;
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: Uint8Array.of(cls) },
        key,
        payload.slice().buffer
      )
    );
    // Encrypting awaited, and the note may have been closed meanwhile.
    if (this.destroyed || this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const head =
      target === null
        ? Uint8Array.of(cls)
        : Uint8Array.of(
            cls,
            (target >>> 24) & 0xff,
            (target >>> 16) & 0xff,
            (target >>> 8) & 0xff,
            target & 0xff
          );
    try {
      ws.send(concat(head, iv, ciphertext));
    } catch (err) {
      console.warn('[room] send failed %s', this.label(), err);
    }
  }

  private async handleMessage(ws: WebSocket, data: unknown): Promise<void> {
    if (!(data instanceof ArrayBuffer) || this.ws !== ws) return;
    const frame = new Uint8Array(data);
    if (frame.byteLength === 0) return;
    const kind = frame[0];
    if (kind < ROOM_CLASS_UPDATE) {
      this.handleControl(kind, frame.subarray(1));
      return;
    }
    const key = this.cryptoKey;
    if (!key || frame.byteLength < 1 + SENDER_BYTES + IV_BYTES) return;
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const sender = view.getUint32(1);
    const iv = frame.slice(1 + SENDER_BYTES, 1 + SENDER_BYTES + IV_BYTES);
    const ciphertext = frame.slice(1 + SENDER_BYTES + IV_BYTES);
    let payload: Uint8Array;
    try {
      payload = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv, additionalData: Uint8Array.of(kind) },
          key,
          ciphertext.buffer
        )
      );
    } catch (err) {
      // A different key on the other device, or a payload relabelled with
      // another class. Either way it is not for us to act on.
      console.warn(
        '[room] decrypt failed %s class=0x%s frame=%dB',
        this.label(),
        kind.toString(16),
        frame.byteLength,
        err
      );
      return;
    }
    // Decrypting awaited: the note may be closed, or this socket replaced.
    if (this.destroyed || this.ws !== ws) return;
    try {
      this.opts.onFrame({ cls: kind, sender, payload });
    } catch (err) {
      // Any member can send bytes that are not what the class promises.
      // That costs them the frame, not us the connection.
      console.warn(
        '[room] frame not understood %s class=0x%s payload=%dB',
        this.label(),
        kind.toString(16),
        payload.byteLength,
        err
      );
    }
  }

  private handleControl(kind: number, body: Uint8Array): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(new TextDecoder().decode(body));
    } catch {
      console.warn('[room] unreadable control frame %s', this.label());
      return;
    }
    switch (kind) {
      case FRAME_WELCOME: {
        if (!Number.isInteger(message.you)) return;
        this.selfId = message.you as number;
        this.accessLevel = Number.isInteger(message.accessLevel)
          ? (message.accessLevel as number)
          : ROOM_ACCESS_READ_ONLY;
        this.roster.clear();
        const peers = Array.isArray(message.peers) ? message.peers : [];
        for (const peer of peers) {
          if (isPeer(peer)) this.roster.set(peer.id, peer);
        }
        this.joined = true;
        this.reconnectAttempt = 0;
        console.info(
          '[room] joined %s peers=%d write=%s',
          this.label(),
          this.roster.size,
          this.canWrite
        );
        this.opts.onPeersChange?.(this.peers);
        this.opts.onStatusChange?.(true);
        this.opts.onOpen?.();
        break;
      }
      case FRAME_JOINED:
        if (!isPeer(message) || message.id === this.selfId) return;
        this.roster.set(message.id, {
          id: message.id,
          username: message.username,
          accessLevel: message.accessLevel
        });
        this.opts.onPeersChange?.(this.peers);
        break;
      case FRAME_LEFT: {
        const id = message.id;
        if (typeof id !== 'number' || !this.roster.delete(id)) return;
        this.opts.onPeerLeft?.(id);
        this.opts.onPeersChange?.(this.peers);
        break;
      }
      case FRAME_ACCESS:
        // Our own access changed while we were in the room.
        if (Number.isInteger(message.accessLevel)) {
          this.accessLevel = message.accessLevel as number;
        }
        break;
      default:
        break;
    }
  }
}
