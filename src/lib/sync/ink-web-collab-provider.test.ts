import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  ADMIN,
  FakeRoomServer,
  READ_ONLY,
  READ_WRITE,
  settle,
  trackCrypto
} from './fake-room-server';
import { InkWebCollabProvider } from './ink-web-collab-provider';
import { ROOM_CLASS_UPDATE } from './room-socket';

const KEY = new Uint8Array(32).fill(5);

let server: FakeRoomServer;
let cleanup: Array<() => void>;

beforeEach(() => {
  server = new FakeRoomServer();
  cleanup = [];
  vi.stubGlobal('WebSocket', server.WebSocket);
  trackCrypto();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  for (const undo of cleanup.reverse()) undo();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A device with an ink note open. The editor's wasm handle owns the document
 * in the app; a Y.Doc stands in for it here, since the provider only ever
 * moves the handle's bytes around.
 */
function device(username: string, accessLevel: number, strokes: string[] = []) {
  const doc = new Y.Doc();
  const list = doc.getArray<string>('strokes');
  list.push(strokes);
  let provider: InkWebCollabProvider | null = null;
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') provider?.sendLocalUpdate(update);
  });
  cleanup.push(() => {
    provider?.destroy();
    doc.destroy();
  });
  return {
    strokes: () => list.toArray().sort(),
    draw: (stroke: string) => list.push([stroke]),
    open() {
      provider = new InkWebCollabProvider({
        noteId: 'note',
        url: 'ws://server/api/v1/room/',
        keyBytes: KEY,
        getTicket: async () => server.ticket(username, accessLevel),
        handle: {
          encode_state_vector: () => Y.encodeStateVector(doc),
          encode_diff_for_state_vector: (vector) =>
            Y.encodeStateAsUpdate(doc, vector),
          apply_remote_update: (update) => {
            try {
              Y.applyUpdate(doc, update, 'remote');
              return true;
            } catch {
              return false;
            }
          }
        }
      });
      return provider;
    }
  };
}

describe('live ink co-editing', () => {
  it('trades what each device drew before they met, then follows along', async () => {
    const ann = device('ann', ADMIN, ['a1', 'a2']);
    const bob = device('bob', READ_WRITE, ['b1']);
    ann.open();
    await settle();
    bob.open();
    await settle();
    expect(ann.strokes()).toEqual(['a1', 'a2', 'b1']);
    expect(bob.strokes()).toEqual(['a1', 'a2', 'b1']);

    bob.draw('b2');
    await settle();
    expect(ann.strokes()).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('lets a member who may only read watch without drawing for the others', async () => {
    const reader = device('reader', READ_ONLY);
    const ann = device('ann', ADMIN, ['a1']);
    // The reader is there first and cannot answer the writer's request,
    // so it asks for the state itself.
    reader.open();
    await settle();
    ann.open();
    await settle();
    expect(reader.strokes()).toEqual(['a1']);

    ann.draw('a2');
    await settle();
    expect(reader.strokes()).toEqual(['a1', 'a2']);

    reader.draw('scribble');
    await settle();
    expect(ann.strokes()).toEqual(['a1', 'a2']);
    expect(
      server.received.some(
        ({ sender, frame }) => sender === 1 && frame[0] === ROOM_CLASS_UPDATE
      )
    ).toBe(false);
  });

  it('survives an update it cannot apply', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ann = device('ann', ADMIN);
    const bob = device('bob', READ_WRITE);
    ann.open();
    const provider = bob.open();
    await settle();

    provider.sendLocalUpdate(Uint8Array.of(255, 255, 255, 255));
    await settle();
    expect(warn).toHaveBeenCalled();

    bob.draw('b1');
    await settle();
    expect(ann.strokes()).toEqual(['b1']);
  });

  it('sends nothing after it is destroyed', async () => {
    const ann = device('ann', ADMIN);
    const bob = device('bob', READ_WRITE);
    ann.open();
    const provider = bob.open();
    await settle();
    const before = server.received.length;

    provider.destroy();
    bob.draw('late');
    provider.sendLocalUpdate(new Uint8Array(0));
    await settle();
    expect(server.received.length).toBe(before);
    expect(ann.strokes()).toEqual([]);
  });
});
