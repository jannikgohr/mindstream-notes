import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN,
  FakeRoomServer,
  READ_ONLY,
  READ_WRITE,
  settle,
  trackCrypto
} from './fake-room-server';
import {
  ROOM_CLASS_PRESENCE,
  ROOM_CLASS_SYNC,
  ROOM_CLASS_UPDATE,
  RoomSocket,
  type RoomFrame,
  type RoomSocketOptions
} from './room-socket';

const KEY = new Uint8Array(32).fill(7);
const text = (value: string) => new TextEncoder().encode(value);
const read = (frame: RoomFrame) => new TextDecoder().decode(frame.payload);

let server: FakeRoomServer;

beforeEach(() => {
  server = new FakeRoomServer();
  vi.stubGlobal('WebSocket', server.WebSocket);
  trackCrypto();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A member's socket, with everything it was told recorded. */
function join(
  username: string,
  accessLevel: number,
  overrides: Partial<RoomSocketOptions> = {}
) {
  const frames: RoomFrame[] = [];
  const status: boolean[] = [];
  const left: number[] = [];
  let opened = 0;
  const socket = new RoomSocket({
    url: 'ws://server/api/v1/room/',
    keyBytes: KEY,
    getTicket: async () => server.ticket(username, accessLevel),
    onFrame: (frame) => frames.push(frame),
    onOpen: () => {
      opened += 1;
    },
    onPeerLeft: (id) => left.push(id),
    onStatusChange: (online) => status.push(online),
    ...overrides
  });
  return {
    socket,
    frames,
    status,
    left,
    opened: () => opened
  };
}

describe('room socket', () => {
  it('shows its ticket first and waits to be welcomed', async () => {
    const ann = join('ann', ADMIN);
    expect(ann.socket.canWrite).toBe(false);
    // Nothing is sent before the server has let us in.
    await ann.socket.send(ROOM_CLASS_UPDATE, text('too early'));
    await settle();

    expect(ann.opened()).toBe(1);
    expect(ann.status).toEqual([true]);
    expect(ann.socket.canWrite).toBe(true);
    expect(server.usernames()).toEqual(['ann']);
    expect(server.received).toEqual([]);
  });

  it('tells each member who is there and who comes and goes', async () => {
    const ann = join('ann', ADMIN);
    await settle();
    const bob = join('bob', READ_ONLY);
    await settle();

    // Names come from the server, which authenticated them.
    expect(bob.socket.peers.map((peer) => peer.username)).toEqual(['ann']);
    expect(ann.socket.peers).toEqual([
      { id: 2, username: 'bob', accessLevel: READ_ONLY }
    ]);
    expect(ann.socket.peerCanWrite(2)).toBe(false);
    expect(bob.socket.peerCanWrite(1)).toBe(true);

    bob.socket.destroy();
    await settle();
    expect(ann.left).toEqual([2]);
    expect(ann.socket.peers).toEqual([]);
  });

  it('carries payloads the server cannot read to everyone else', async () => {
    const ann = join('ann', ADMIN);
    const bob = join('bob', READ_WRITE);
    const cat = join('cat', READ_ONLY);
    await settle();

    await ann.socket.send(ROOM_CLASS_UPDATE, text('an edit'));
    await settle();

    for (const member of [bob, cat]) {
      expect(member.frames).toHaveLength(1);
      expect(member.frames[0].cls).toBe(ROOM_CLASS_UPDATE);
      expect(member.frames[0].sender).toBe(1);
      expect(read(member.frames[0])).toBe('an edit');
    }
    expect(ann.frames).toEqual([]);
    // What crossed the server is not the plaintext.
    const wire = new TextDecoder().decode(server.received[0].frame);
    expect(wire).not.toContain('an edit');
  });

  it('answers one member and nobody else', async () => {
    const ann = join('ann', ADMIN);
    const bob = join('bob', READ_WRITE);
    const cat = join('cat', READ_WRITE);
    await settle();

    await ann.socket.reply(2, text('for bob'));
    await settle();

    expect(bob.frames.map(read)).toEqual(['for bob']);
    expect(cat.frames).toEqual([]);
  });

  it('does not act on a payload sent under another class', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ann = join('ann', ADMIN);
    const bob = join('bob', READ_WRITE);
    await settle();
    await ann.socket.send(ROOM_CLASS_PRESENCE, text('a cursor'));
    await settle();
    expect(bob.frames.map(read)).toEqual(['a cursor']);

    // The same ciphertext, relabelled as a document change on its way
    // through. The class is part of what was encrypted, so it is refused.
    const sent = server.received[0].frame;
    const relabelled = new Uint8Array(1 + 4 + sent.byteLength - 1);
    relabelled[0] = ROOM_CLASS_UPDATE;
    relabelled.set([0, 0, 0, 1], 1);
    relabelled.set(sent.subarray(1), 5);
    const bobSocket = (
      bob.socket as unknown as {
        ws: { onmessage(event: { data: ArrayBuffer }): void };
      }
    ).ws;
    bobSocket.onmessage({ data: relabelled.buffer });
    await settle();

    expect(bob.frames).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });

  it('cannot read a room encrypted under another key', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ann = join('ann', ADMIN);
    const eve = join('eve', READ_WRITE, {
      keyBytes: new Uint8Array(32).fill(9)
    });
    await settle();
    await ann.socket.send(ROOM_CLASS_UPDATE, text('secret'));
    await settle();
    expect(eve.frames).toEqual([]);
  });

  it('knows when it may write, and hears when that changes', async () => {
    const bob = join('bob', READ_ONLY);
    await settle();
    expect(bob.socket.canWrite).toBe(false);

    server.setAccess('bob', READ_WRITE);
    await settle();
    expect(bob.socket.canWrite).toBe(true);

    server.setAccess('bob', READ_ONLY);
    await settle();
    expect(bob.socket.canWrite).toBe(false);
  });

  it('comes back with a new ticket after the connection drops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ann = join('ann', ADMIN);
    const bob = join('bob', READ_WRITE);
    await settle();
    expect(bob.left).toEqual([]);

    server.drop('ann', 1006);
    await settle();
    expect(ann.status).toEqual([true, false]);
    expect(ann.socket.canWrite).toBe(false);
    expect(ann.socket.peers).toEqual([]);
    expect(bob.left).toEqual([1]);
    expect(server.opened).toBe(2);

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(server.opened).toBe(3);
    expect(ann.status).toEqual([true, false, true]);
    expect(ann.opened()).toBe(2);
    expect(server.usernames()).toEqual(['bob', 'ann']);
  });

  it('stops asking once the server will not let it in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let asked = 0;
    const ann = join('ann', ADMIN, {
      getTicket: async () => {
        asked += 1;
        // In once, then removed from the collection.
        return asked === 1 ? server.ticket('ann', ADMIN) : null;
      }
    });
    await settle();
    server.drop('ann');
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();

    expect(asked).toBe(2);
    expect(server.opened).toBe(1);
    expect(ann.status).toEqual([true, false]);
  });

  it('keeps trying while the ticket cannot be asked for', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let asked = 0;
    const ann = join('ann', ADMIN, {
      getTicket: async () => {
        asked += 1;
        if (asked < 3) throw new Error('offline');
        return server.ticket('ann', ADMIN);
      }
    });
    await settle();
    expect(server.opened).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();

    expect(asked).toBe(3);
    expect(ann.status).toEqual([true]);
  });

  it('is refused with a ticket the server does not know', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ann = join('ann', ADMIN, { getTicket: async () => 'made-up' });
    await settle();
    expect(ann.status).toEqual([]);
    expect(ann.socket.canWrite).toBe(false);
    expect(server.usernames()).toEqual([]);
  });

  it('goes quiet when destroyed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ann = join('ann', ADMIN);
    const bob = join('bob', READ_WRITE);
    await settle();

    ann.socket.destroy();
    await ann.socket.send(ROOM_CLASS_SYNC, text('after'));
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();

    expect(server.usernames()).toEqual(['bob']);
    expect(server.opened).toBe(2);
    expect(bob.frames).toEqual([]);
    expect(ann.status).toEqual([true, false]);
  });
});
