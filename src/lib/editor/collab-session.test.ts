import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCollabSession, roomConnection } from './collab-session';
const mocks = vi.hoisted(() => ({ room: vi.fn(), ticket: vi.fn() }));
vi.mock('$lib/api', () => ({
  noteRoomInfo: mocks.room,
  noteRoomTicket: mocks.ticket
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const room = {
  url: 'ws://server/api/v1/room/',
  collection: 'col',
  item: 'item',
  ticket: 'first-ticket',
  key_b64: 'AQID'
};
function harness() {
  const created: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  const create = vi.fn(() => {
    const provider = { destroy: vi.fn() };
    created.push(provider);
    return provider;
  });
  const onProvider = vi.fn();
  const session = createCollabSession({
    getContext: () => ({ noteId: 'note', url: 'ws://relay', value: {} }),
    create,
    onProvider
  });
  return { session, create, created, onProvider };
}
beforeEach(() => {
  mocks.room.mockReset().mockResolvedValue(room);
  mocks.ticket.mockReset().mockResolvedValue('fresh-ticket');
});
describe('collab session', () => {
  it('does not construct a provider after unmount during room lookup', async () => {
    const lookup = deferred<typeof room>();
    mocks.room.mockReturnValue(lookup.promise);
    const { session, create } = harness();
    const connecting = session.setup();
    await Promise.resolve();
    session.destroy();
    lookup.resolve(room);
    await connecting;
    expect(create).not.toHaveBeenCalled();
  });
  it('only installs the latest overlapping setup and destroys the live provider', async () => {
    const lookup = deferred<typeof room>();
    mocks.room.mockReturnValueOnce(lookup.promise);
    const { session, create, created } = harness();
    const first = session.setup();
    await Promise.resolve();
    await session.setup();
    lookup.resolve(room);
    await first;
    expect(create).toHaveBeenCalledTimes(1);
    session.destroy();
    expect(created[0].destroy).toHaveBeenCalledTimes(1);
  });
  it('cancels an in-flight connection when collaboration is paused', async () => {
    const lookup = deferred<typeof room>();
    mocks.room.mockReturnValue(lookup.promise);
    const { session, create } = harness();
    const connecting = session.setup();
    await Promise.resolve();
    session.disconnect();
    lookup.resolve(room);
    await connecting;
    expect(create).not.toHaveBeenCalled();
  });
  it('hands the provider the room the lookup named', async () => {
    const connections: Array<{ url: string; keyBytes: Uint8Array }> = [];
    const session = createCollabSession({
      getContext: () => ({ noteId: 'n', url: 'ws://r', value: {} }),
      create: (_, connection) => {
        connections.push(connection);
        return { destroy() {} };
      }
    });
    await session.setup();
    expect(connections[0].url).toBe(room.url);
    expect([...connections[0].keyBytes]).toEqual([1, 2, 3]);
    session.destroy();
  });
});
describe('room connection', () => {
  it('uses the ticket that came with the room once, then asks for more', async () => {
    const connection = roomConnection(room);
    expect(await connection.getTicket()).toBe('first-ticket');
    expect(mocks.ticket).not.toHaveBeenCalled();
    // A ticket is good for one socket. A reconnect needs its own.
    expect(await connection.getTicket()).toBe('fresh-ticket');
    expect(mocks.ticket).toHaveBeenCalledWith('col', 'item');
  });
  it('does not trust a ticket that has been lying around', async () => {
    vi.useFakeTimers();
    try {
      const connection = roomConnection(room);
      vi.advanceTimersByTime(20_000);
      expect(await connection.getTicket()).toBe('fresh-ticket');
    } finally {
      vi.useRealTimers();
    }
  });
  it('passes on that the server will not let the account in', async () => {
    mocks.ticket.mockResolvedValue(null);
    const connection = roomConnection(room);
    await connection.getTicket();
    expect(await connection.getTicket()).toBeNull();
  });
});
