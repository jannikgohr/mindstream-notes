/**
 * A stand-in for the sync server's rooms, for unit tests.
 *
 * It follows the rules the real server enforces, so a test of a provider
 * exercises them: the first frame must be a ticket, the server names the
 * sender of every frame it relays, replies go to one member, and document
 * changes from a member who may only read are dropped.
 *
 * Install it with `vi.stubGlobal('WebSocket', server.WebSocket)`, and call
 * `trackCrypto()` so `settle()` knows when the room has gone quiet.
 */

import { vi } from 'vitest';

const FRAME_HELLO = 0x01;
const FRAME_WELCOME = 0x02;
const FRAME_JOINED = 0x03;
const FRAME_LEFT = 0x04;
const FRAME_ACCESS = 0x05;
const CLASS_UPDATE = 0x10;
const CLASS_REPLY = 0x12;

export const READ_ONLY = 0;
export const ADMIN = 1;
export const READ_WRITE = 2;

interface Member {
  id: number;
  username: string;
  accessLevel: number;
  socket: FakeSocket;
}

interface FakeSocket {
  readyState: number;
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}

function control(kind: number, body: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(body));
  const frame = new Uint8Array(1 + json.byteLength);
  frame[0] = kind;
  frame.set(json, 1);
  return frame;
}

export class FakeRoomServer {
  /** Tickets the server will honour, and who they let in as. */
  private readonly tickets = new Map<
    string,
    { username: string; accessLevel: number }
  >();
  private readonly members = new Map<number, Member>();
  private nextId = 1;
  private nextTicket = 1;
  /** Every frame a member sent after its ticket, as (sender id, bytes). */
  readonly received: Array<{ sender: number; frame: Uint8Array }> = [];
  /** Sockets opened so far, including ones that were refused. */
  opened = 0;
  readonly WebSocket: {
    new (url: string): FakeSocket;
    readonly OPEN: number;
  };

  constructor() {
    const connect = (socket: FakeSocket) => this.accept(socket);
    const hear = (socket: FakeSocket, data: Uint8Array) =>
      this.hear(socket, data);
    const depart = (socket: FakeSocket) => this.depart(socket);
    const count = () => {
      this.opened += 1;
    };
    this.WebSocket = class implements FakeSocket {
      static readonly OPEN = 1;
      readyState = 0;
      binaryType = 'blob';
      onopen: FakeSocket['onopen'] = null;
      onmessage: FakeSocket['onmessage'] = null;
      onclose: FakeSocket['onclose'] = null;
      onerror: FakeSocket['onerror'] = null;
      constructor(readonly url: string) {
        count();
        queueMicrotask(() => connect(this));
      }
      send(data: Uint8Array): void {
        if (this.readyState !== 1) throw new Error('socket is not open');
        hear(this, new Uint8Array(data));
      }
      close(): void {
        if (this.readyState === 3) return;
        this.readyState = 3;
        depart(this);
        this.onclose?.({ code: 1000, reason: '' });
      }
    };
  }

  /** A ticket that lets its holder in as `username`. One socket each. */
  ticket(username: string, accessLevel: number): string {
    const ticket = `ticket-${this.nextTicket++}`;
    this.tickets.set(ticket, { username, accessLevel });
    return ticket;
  }

  /** The usernames in the room, in the order they joined. */
  usernames(): string[] {
    return [...this.members.values()].map((member) => member.username);
  }

  /** Change a member's access while it is in the room. */
  setAccess(username: string, accessLevel: number): void {
    for (const member of this.members.values()) {
      if (member.username !== username) continue;
      member.accessLevel = accessLevel;
      this.deliver(member, control(FRAME_ACCESS, { accessLevel }));
    }
  }

  /** Close a member's socket from the server's side. */
  drop(username: string, code = 4403): void {
    for (const member of [...this.members.values()]) {
      if (member.username !== username) continue;
      this.remove(member);
      member.socket.readyState = 3;
      member.socket.onclose?.({ code, reason: '' });
    }
  }

  private accept(socket: FakeSocket): void {
    if (socket.readyState !== 0) return;
    socket.readyState = 1;
    socket.onopen?.({});
  }

  private memberOf(socket: FakeSocket): Member | undefined {
    return [...this.members.values()].find((m) => m.socket === socket);
  }

  private deliver(member: Member, frame: Uint8Array): void {
    const copy = frame.slice();
    queueMicrotask(() => {
      if (member.socket.readyState !== 1) return;
      member.socket.onmessage?.({ data: copy.buffer });
    });
  }

  private refuse(socket: FakeSocket, code: number): void {
    socket.readyState = 3;
    queueMicrotask(() => socket.onclose?.({ code, reason: '' }));
  }

  private hear(socket: FakeSocket, frame: Uint8Array): void {
    const member = this.memberOf(socket);
    if (!member) {
      const ticket = new TextDecoder().decode(frame.subarray(1));
      const holder = this.tickets.get(ticket);
      if (frame[0] !== FRAME_HELLO || !holder) {
        this.refuse(socket, 4401);
        return;
      }
      this.tickets.delete(ticket);
      const joined: Member = { id: this.nextId++, ...holder, socket };
      const describe = (m: Member) => ({
        id: m.id,
        username: m.username,
        accessLevel: m.accessLevel
      });
      this.deliver(
        joined,
        control(FRAME_WELCOME, {
          you: joined.id,
          accessLevel: joined.accessLevel,
          peers: [...this.members.values()].map(describe)
        })
      );
      for (const other of this.members.values()) {
        this.deliver(other, control(FRAME_JOINED, describe(joined)));
      }
      this.members.set(joined.id, joined);
      return;
    }

    this.received.push({ sender: member.id, frame });
    const cls = frame[0];
    const needsWrite = cls === CLASS_UPDATE || cls === CLASS_REPLY;
    if (needsWrite && member.accessLevel === READ_ONLY) return;
    const sender = Uint8Array.of(
      (member.id >>> 24) & 0xff,
      (member.id >>> 16) & 0xff,
      (member.id >>> 8) & 0xff,
      member.id & 0xff
    );
    const relay = (body: Uint8Array) => {
      const out = new Uint8Array(1 + 4 + body.byteLength);
      out[0] = cls;
      out.set(sender, 1);
      out.set(body, 5);
      return out;
    };
    if (cls === CLASS_REPLY) {
      const target = new DataView(
        frame.buffer,
        frame.byteOffset,
        frame.byteLength
      ).getUint32(1);
      const peer = this.members.get(target);
      if (peer) this.deliver(peer, relay(frame.subarray(5)));
      return;
    }
    for (const other of this.members.values()) {
      if (other !== member) this.deliver(other, relay(frame.subarray(1)));
    }
  }

  private remove(member: Member): void {
    this.members.delete(member.id);
    for (const other of this.members.values()) {
      this.deliver(other, control(FRAME_LEFT, { id: member.id }));
    }
  }

  private depart(socket: FakeSocket): void {
    const member = this.memberOf(socket);
    if (member) this.remove(member);
  }
}

/** Encryptions, decryptions and key imports still under way. */
let cryptoInFlight = 0;

/**
 * Count the crypto operations in flight. They finish on another thread, in
 * their own time, so without this a test could only guess how long to wait.
 * Undone by `vi.restoreAllMocks()`.
 */
export function trackCrypto(): void {
  cryptoInFlight = 0;
  const subtle = crypto.subtle;
  for (const name of ['encrypt', 'decrypt', 'importKey'] as const) {
    const original = subtle[name].bind(subtle) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    vi.spyOn(subtle, name).mockImplementation(((...args: unknown[]) => {
      cryptoInFlight += 1;
      return original(...args).finally(() => {
        cryptoInFlight -= 1;
      });
    }) as never);
  }
}

/** Wait until every queued message has been delivered and acted on. */
export async function settle(): Promise<void> {
  let quiet = 0;
  while (quiet < 5) {
    await new Promise((resolve) => setImmediate(resolve));
    quiet = cryptoInFlight === 0 ? quiet + 1 : 0;
  }
}
