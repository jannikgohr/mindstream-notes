import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCollabSession } from './collab-session';
const mocks = vi.hoisted(() => ({ room: vi.fn(), signing: vi.fn() }));
vi.mock('$lib/api', () => ({ noteRoomInfo: mocks.room }));
vi.mock('$lib/sync/collab-signing-key', () => ({
  getOrCreateCollabSigningMaterial: mocks.signing,
  collabAuthForRoom: () => undefined
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const room = { room_id: 'room', key_b64: 'AQID', collab_epoch: 0 };
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
  mocks.signing.mockReset().mockResolvedValue(null);
});
describe('collab session', () => {
  it('does not look up a room after unmount during signing lookup', async () => {
    const signing = deferred<null>();
    mocks.signing.mockReturnValue(signing.promise);
    const { session, create } = harness();
    const connecting = session.setup();
    session.destroy();
    signing.resolve(null);
    await connecting;
    expect(mocks.room).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
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
  it('ignores stale authentication callbacks after replacing the provider', async () => {
    const callbacks: Array<(() => void) | undefined> = [];
    const session = createCollabSession({
      getContext: () => ({ noteId: 'n', url: 'ws://r', value: {} }),
      create: (_, options) => {
        callbacks.push(options.onAuthStale);
        return { destroy() {} };
      }
    });
    await session.setup();
    await session.setup();
    callbacks[0]?.();
    expect(mocks.room).toHaveBeenCalledTimes(2);
    session.destroy();
  });
});
