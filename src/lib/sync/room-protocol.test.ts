/**
 * The room protocol is written down once, in protocol/room, and three pieces
 * of code speak it: the server's hub, the app's room socket and the fake
 * server these unit tests use. The server has its own tests against the file.
 * This holds the other two to it, so that a test passing against the fake
 * says something about the real server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import spec from '../../../protocol/room/room-protocol.json';
import {
  ADMIN,
  FakeRoomServer,
  READ_ONLY,
  READ_WRITE,
  settle,
  trackCrypto
} from './fake-room-server';
import {
  ROOM_ACCESS_READ_ONLY,
  ROOM_CLASS_PRESENCE,
  ROOM_CLASS_REPLY,
  ROOM_CLASS_SYNC,
  ROOM_CLASS_UPDATE,
  RoomSocket
} from './room-socket';
import type { RoomFrame } from './room-socket';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const frames = spec.frames as Record<string, number>;
const classes = spec.classes as Record<string, number>;
const levels = spec.accessLevels as Record<string, number>;

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function hex(data: Uint8Array): string {
  return [...data].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A control frame as the protocol lays it out: its kind, then JSON. */
function control(kind: string, body: Json): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(body));
  const frame = new Uint8Array(1 + json.byteLength);
  frame[0] = frames[kind];
  frame.set(json, 1);
  return frame;
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the numbers', () => {
  it('are the ones the app uses', () => {
    expect(ROOM_CLASS_UPDATE).toBe(classes.update);
    expect(ROOM_CLASS_SYNC).toBe(classes.sync);
    expect(ROOM_CLASS_REPLY).toBe(classes.reply);
    expect(ROOM_CLASS_PRESENCE).toBe(classes.presence);
    expect(ROOM_ACCESS_READ_ONLY).toBe(levels.readOnly);
  });

  it('are the ones the fake server uses', () => {
    expect(READ_ONLY).toBe(levels.readOnly);
    expect(ADMIN).toBe(levels.admin);
    expect(READ_WRITE).toBe(levels.readWrite);
  });

  it('keep every control frame below every class', () => {
    // A receiver tells the two apart by comparing with the lowest class.
    const lowest = Math.min(...Object.values(classes));
    expect(lowest).toBe(classes.update);
    for (const kind of Object.values(frames)) expect(kind).toBeLessThan(lowest);
  });
});

describe('the fake server', () => {
  /** A bare socket on the fake: what it was sent, in order. */
  function connect(server: FakeRoomServer) {
    const received: Uint8Array[] = [];
    const socket = new server.WebSocket('ws://server/api/v1/room/');
    socket.binaryType = 'arraybuffer';
    socket.onmessage = (event) => received.push(new Uint8Array(event.data));
    return { socket, received };
  }

  it('holds the conversation the protocol file describes', async () => {
    const server = new FakeRoomServer();
    const players = new Map<
      string,
      ReturnType<typeof connect> & { id: number | null }
    >();
    const idOf = (name: string) => {
      const id = players.get(name)?.id;
      if (id === null || id === undefined) throw new Error(`${name} is not in`);
      return id;
    };

    /** A body from the file with its names turned into this room's. */
    const inThisRoom = (body: Json, key?: string): Json => {
      if (Array.isArray(body)) return body.map((item) => inThisRoom(item));
      if (body !== null && typeof body === 'object') {
        return Object.fromEntries(
          Object.entries(body).map(([name, value]) => [
            name,
            inThisRoom(value, name)
          ])
        );
      }
      if (typeof body !== 'string') return body;
      if (key === 'you' || key === 'id') return idOf(body);
      if (key === 'accessLevel') return levels[body];
      return body;
    };

    // Each step has its own fields, so the file's own type is a union of
    // every one of them. The steps are read by what they hold instead.
    const steps = spec.exchange as unknown as Record<string, Json>[];
    for (const [number, step] of steps.entries()) {
      const what = `step ${number}: ${JSON.stringify(step)}`;
      if (typeof step.join === 'string') {
        const player = { ...connect(server), id: null as number | null };
        players.set(step.join, player);
        await settle();
        const ticket = server.ticket(step.join, levels[step.access as string]);
        player.socket.send(
          new Uint8Array([frames.hello, ...new TextEncoder().encode(ticket)])
        );
        await settle();
        // The welcome says which id the server gave.
        const welcome = player.received[0];
        expect(welcome?.[0], what).toBe(frames.welcome);
        player.id = JSON.parse(new TextDecoder().decode(welcome.subarray(1)))
          .you as number;
      } else if (typeof step.send === 'string') {
        const payload = bytes(step.payload as string);
        const header =
          typeof step.target === 'string'
            ? [classes[step.class as string], ...be32(idOf(step.target))]
            : [classes[step.class as string]];
        players
          .get(step.send)!
          .socket.send(new Uint8Array([...header, ...payload]));
      } else if (typeof step.setAccess === 'string') {
        server.setAccess(step.setAccess, levels[step.access as string]);
      } else if (typeof step.leave === 'string') {
        players.get(step.leave)!.socket.close();
      } else {
        throw new Error(`a step this test does not know how to take: ${what}`);
      }
      await settle();

      for (const expected of step.then as Record<string, Json>[]) {
        const to = expected.to as string;
        const got = players.get(to)!.received.shift();
        expect(got, `${what}, to ${to}`).toBeDefined();
        if (typeof expected.frame === 'string') {
          expect(got![0], what).toBe(frames[expected.frame]);
          expect(
            JSON.parse(new TextDecoder().decode(got!.subarray(1))),
            what
          ).toEqual(inThisRoom(expected.body));
        } else {
          expect(hex(got!), what).toBe(
            hex(
              new Uint8Array([
                classes[expected.class as string],
                ...be32(idOf(expected.sender as string)),
                ...bytes(expected.payload as string)
              ])
            )
          );
        }
      }
    }
    // Nothing was sent that the file does not account for.
    for (const [name, player] of players) {
      expect(player.received, `left over for ${name}`).toEqual([]);
    }
  });
});

function be32(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ];
}

describe("the app's room socket", () => {
  const examples = spec.examples;
  const KEY = new Uint8Array(32).fill(7);

  /** A socket with nothing behind it: the test is the server. */
  class WireSocket {
    static readonly OPEN = 1;
    static last: WireSocket | null = null;
    readyState = 0;
    binaryType = 'blob';
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    readonly sent: Uint8Array[] = [];
    constructor(readonly url: string) {
      WireSocket.last = this;
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.({});
      });
    }
    send(data: Uint8Array): void {
      this.sent.push(new Uint8Array(data));
    }
    close(): void {
      this.readyState = 3;
    }
    /** Deliver a frame as the server would. */
    deliver(frame: Uint8Array): void {
      this.onmessage?.({ data: frame.slice().buffer as ArrayBuffer });
    }
  }

  async function open(ticket = 'ticket') {
    const heard: RoomFrame[] = [];
    const left: number[] = [];
    let opened = 0;
    const socket = new RoomSocket({
      url: 'ws://server/api/v1/room/',
      keyBytes: KEY,
      getTicket: async () => ticket,
      onFrame: (frame) => heard.push(frame),
      onOpen: () => {
        opened += 1;
      },
      onPeerLeft: (id) => left.push(id)
    });
    await settle();
    const wire = WireSocket.last!;
    return { socket, wire, heard, left, opened: () => opened };
  }

  beforeEach(() => {
    WireSocket.last = null;
    vi.stubGlobal('WebSocket', WireSocket);
    trackCrypto();
  });

  it('shows its ticket in the first frame, laid out as written', async () => {
    const { wire } = await open(examples.hello.ticket);

    expect(wire.sent.map(hex)).toEqual([examples.hello.hex]);
  });

  it('reads a welcome and a change of access', async () => {
    const { socket, wire, opened } = await open();

    wire.deliver(control('welcome', examples.welcome.body));
    await settle();
    expect(opened()).toBe(1);
    expect(socket.peers).toEqual(examples.welcome.body.peers);
    // The example welcomes someone who may only read.
    expect(examples.welcome.body.accessLevel).toBe(levels.readOnly);
    expect(socket.canWrite).toBe(false);

    wire.deliver(control('access', examples.access.body));
    await settle();
    expect(examples.access.body.accessLevel).toBe(levels.readWrite);
    expect(socket.canWrite).toBe(true);
  });

  it('reads who joins and who leaves', async () => {
    const { socket, wire, left } = await open();
    wire.deliver(
      control('welcome', { you: 1, accessLevel: levels.admin, peers: [] })
    );
    await settle();
    expect(socket.peers).toEqual([]);

    wire.deliver(control('joined', examples.joined.body));
    await settle();
    expect(socket.peers).toEqual([examples.joined.body]);
    expect(socket.peerCanWrite(examples.joined.body.id)).toBe(false);

    wire.deliver(control('left', examples.left.body));
    await settle();
    expect(left).toEqual([examples.left.body.id]);
    expect(socket.peers).toEqual([]);
  });

  it('lays out what it sends, and reads it back once it is relayed', async () => {
    const ann = await open();
    ann.wire.deliver(
      control('welcome', { you: 1, accessLevel: levels.admin, peers: [] })
    );
    const bob = await open();
    bob.wire.deliver(
      control('welcome', {
        you: 2,
        accessLevel: levels.readWrite,
        peers: [{ id: 1, username: 'ann', accessLevel: levels.admin }]
      })
    );
    await settle();
    const hello = 1;

    // To everyone: the class, then what the server cannot read.
    const payload = bytes(examples.sent.payload);
    await ann.socket.send(classes[examples.sent.class], payload);
    await settle();
    const sent = ann.wire.sent[hello];
    expect(sent[0]).toBe(bytes(examples.sent.hex)[0]);
    // An IV and an authentication tag around the payload, never the payload.
    expect(sent.byteLength).toBe(1 + 12 + payload.byteLength + 16);

    // The server puts the sender between the class and the rest.
    const relayed = new Uint8Array([
      sent[0],
      ...be32(1).slice(4 - spec.senderBytes),
      ...sent.subarray(1)
    ]);
    expect(hex(relayed.subarray(0, 1 + spec.senderBytes))).toBe(
      examples.relayed.hex.slice(0, 2 * (1 + spec.senderBytes))
    );
    bob.wire.deliver(relayed);
    await settle();
    expect(bob.heard).toEqual([
      { cls: classes.update, sender: examples.relayed.sender, payload }
    ]);

    // To one member: the reply class, the target, then the rest.
    await bob.socket.reply(
      examples.sentReply.target,
      bytes(examples.sentReply.payload)
    );
    await settle();
    const reply = bob.wire.sent[hello];
    const head = 2 * (1 + spec.senderBytes);
    expect(hex(reply).slice(0, head)).toBe(
      examples.sentReply.hex.slice(0, head)
    );
  });

  it('does not take a payload relabelled with another class', async () => {
    const ann = await open();
    ann.wire.deliver(
      control('welcome', { you: 1, accessLevel: levels.admin, peers: [] })
    );
    const bob = await open();
    bob.wire.deliver(
      control('welcome', { you: 2, accessLevel: levels.readOnly, peers: [] })
    );
    await settle();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await ann.socket.send(classes.presence, bytes('01'));
    await settle();
    const sent = ann.wire.sent[1];
    // Someone who may only read sends presence. Passed off as an update it
    // would be a change to the document, so the class is part of what is
    // encrypted, and a frame under another class does not open.
    bob.wire.deliver(
      new Uint8Array([classes.update, ...be32(1), ...sent.subarray(1)])
    );
    await settle();
    expect(bob.heard).toEqual([]);

    bob.wire.deliver(
      new Uint8Array([classes.presence, ...be32(1), ...sent.subarray(1)])
    );
    await settle();
    expect(bob.heard).toEqual([
      { cls: classes.presence, sender: 1, payload: bytes('01') }
    ]);
  });
});
