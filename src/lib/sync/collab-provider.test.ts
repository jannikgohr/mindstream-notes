import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate } from 'y-protocols/awareness';
import {
  CollabProvider,
  decodeSyncReply,
  encodeSyncReply
} from './collab-provider';
import {
  ADMIN,
  FakeRoomServer,
  READ_ONLY,
  READ_WRITE,
  settle,
  trackCrypto
} from './fake-room-server';
import { ROOM_CLASS_PRESENCE, ROOM_CLASS_UPDATE } from './room-socket';

const KEY = new Uint8Array(32).fill(3);

let server: FakeRoomServer;
let cleanup: Array<() => void>;

beforeEach(() => {
  server = new FakeRoomServer();
  cleanup = [];
  vi.stubGlobal('WebSocket', server.WebSocket);
  trackCrypto();
  // Presence goes out on the next animation frame. Run it at once.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  for (const undo of cleanup.reverse()) undo();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A device with the note open, and optionally some text already in it. */
function device(username: string, accessLevel: number, initial = '') {
  const doc = new Y.Doc();
  if (initial) doc.getText('body').insert(0, initial);
  const awareness = new Awareness(doc);
  cleanup.push(() => {
    awareness.destroy();
    doc.destroy();
  });
  const text = () => doc.getText('body').toString();
  let provider: CollabProvider | null = null;
  return {
    doc,
    awareness,
    text,
    open() {
      provider = new CollabProvider({
        doc,
        awareness,
        url: 'ws://server/api/v1/room/',
        keyBytes: KEY,
        getTicket: async () => server.ticket(username, accessLevel)
      });
      cleanup.push(() => provider?.destroy());
      return provider;
    },
    close() {
      provider?.destroy();
      provider = null;
    }
  };
}

/** How many frames of a class the server was sent. */
function sent(cls: number): number {
  return server.received.filter(({ frame }) => frame[0] === cls).length;
}

describe('live Yjs co-editing', () => {
  it('brings a joining device up to date and carries edits both ways', async () => {
    const ann = device('ann', ADMIN, 'hello');
    const bob = device('bob', READ_WRITE);
    ann.open();
    await settle();
    bob.open();
    await settle();
    expect(bob.text()).toBe('hello');

    bob.doc.getText('body').insert(5, ' world');
    await settle();
    expect(ann.text()).toBe('hello world');

    ann.doc.getText('body').insert(0, '> ');
    await settle();
    expect(bob.text()).toBe('> hello world');
  });

  it('delivers what a device wrote while it was away', async () => {
    const ann = device('ann', ADMIN);
    const bob = device('bob', READ_WRITE);
    // Both edit before either is connected, as after working offline.
    ann.doc.getText('body').insert(0, 'from ann. ');
    bob.doc.getText('body').insert(0, 'from bob. ');
    ann.open();
    await settle();
    bob.open();
    await settle();

    // The joiner asked; the answer told it what the other side lacks.
    expect(ann.text()).toBe(bob.text());
    expect(ann.text()).toContain('from ann.');
    expect(ann.text()).toContain('from bob.');
    // The whole exchange was addressed, not broadcast to the room.
    expect(sent(ROOM_CLASS_UPDATE)).toBe(0);
  });

  it('lets a member who may only read watch, and keeps its edits to itself', async () => {
    const ann = device('ann', ADMIN, 'the text');
    const reader = device('reader', READ_ONLY);
    ann.open();
    reader.open();
    await settle();
    expect(reader.text()).toBe('the text');

    ann.doc.getText('body').insert(8, ', edited');
    await settle();
    expect(reader.text()).toBe('the text, edited');

    // The reader's own change goes nowhere. It is not even sent.
    reader.doc.getText('body').insert(0, 'vandalism ');
    await settle();
    expect(ann.text()).toBe('the text, edited');
    expect(
      server.received.some(
        ({ sender, frame }) => sender === 2 && frame[0] === ROOM_CLASS_UPDATE
      )
    ).toBe(false);
  });

  it('catches a reader up when a writer arrives after it', async () => {
    const reader = device('reader', READ_ONLY);
    const ann = device('ann', ADMIN, 'written elsewhere');
    reader.open();
    await settle();
    // The reader cannot answer the writer's request for state, so the
    // writer never learns what the reader lacks. The reader asks.
    ann.open();
    await settle();
    expect(reader.text()).toBe('written elsewhere');
  });

  it('starts sending once a member is given write access', async () => {
    const ann = device('ann', ADMIN);
    const bob = device('bob', READ_ONLY);
    ann.open();
    bob.open();
    await settle();

    server.setAccess('bob', READ_WRITE);
    await settle();
    bob.doc.getText('body').insert(0, 'now allowed');
    await settle();
    expect(ann.text()).toBe('now allowed');
  });

  it('shows cursors, and removes one when its device drops off', async () => {
    const ann = device('ann', ADMIN);
    const bob = device('bob', READ_ONLY);
    ann.open();
    bob.open();
    await settle();

    // A member who may only read still shows where it is looking.
    bob.awareness.setLocalStateField('user', { name: 'bob' });
    await settle();
    expect(ann.awareness.getStates().get(bob.doc.clientID)).toEqual({
      user: { name: 'bob' }
    });

    // No goodbye: the connection just ends. The server says who left.
    server.drop('bob', 1006);
    await settle();
    expect(ann.awareness.getStates().has(bob.doc.clientID)).toBe(false);
  });

  it('does not let presence change the document', async () => {
    const ann = device('ann', ADMIN, 'intact');
    const reader = device('reader', READ_ONLY);
    ann.open();
    const provider = reader.open();
    await settle();

    // A reader dressing a document change up as presence. The peers treat
    // presence as presence, whatever is inside.
    const forged = new Y.Doc();
    forged.getText('body').insert(0, 'forged ');
    const socket = (
      provider as unknown as {
        socket: { send(cls: number, payload: Uint8Array): Promise<void> };
      }
    ).socket;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await socket.send(ROOM_CLASS_PRESENCE, Y.encodeStateAsUpdate(forged));
    await settle();
    expect(ann.text()).toBe('intact');
    // It was not presence either. The frame is dropped and the room
    // carries on.
    expect(warn).toHaveBeenCalled();
    ann.doc.getText('body').insert(6, ' still');
    await settle();
    expect(reader.text()).toBe('intact still');
    forged.destroy();
  });
});

describe('collaboration awareness batching', () => {
  it('sends the latest cursor once per animation frame and cancels on destroy', async () => {
    let nextFrame!: FrameRequestCallback;
    const request = vi.fn((callback: FrameRequestCallback) => {
      nextFrame = callback;
      return 1;
    });
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', request);
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const ann = device('ann', ADMIN);
    const peerDoc = new Y.Doc();
    const peer = new Awareness(peerDoc);
    const provider = ann.open();
    const send = vi
      .spyOn(
        (
          provider as unknown as {
            socket: { send(cls: number, payload: Uint8Array): Promise<void> };
          }
        ).socket,
        'send'
      )
      .mockResolvedValue(undefined);
    for (let cursor = 0; cursor < 100; cursor += 1)
      ann.awareness.setLocalState({ cursor });
    expect(request).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    nextFrame(0);
    expect(send).toHaveBeenCalledTimes(1);
    const [cls, payload] = send.mock.calls[0];
    expect(cls).toBe(ROOM_CLASS_PRESENCE);
    applyAwarenessUpdate(peer, payload, 'test');
    expect(peer.getStates().get(ann.doc.clientID)).toEqual({ cursor: 99 });
    ann.awareness.setLocalState({ cursor: 100 });
    ann.close();
    expect(cancel).toHaveBeenCalledWith(1);
    nextFrame(1);
    expect(send).toHaveBeenCalledTimes(1);
    peer.destroy();
    peerDoc.destroy();
    await Promise.resolve();
  });
});

describe('sync reply', () => {
  it('carries an update with or without the state vector', () => {
    const update = Uint8Array.of(1, 2, 3);
    const vector = Uint8Array.of(9, 8);

    const both = decodeSyncReply(encodeSyncReply(update, vector));
    expect(both?.update).toEqual(update);
    expect(both?.stateVector).toEqual(vector);

    const alone = decodeSyncReply(encodeSyncReply(update));
    expect(alone?.update).toEqual(update);
    expect(alone?.stateVector).toBeNull();

    const empty = decodeSyncReply(encodeSyncReply(new Uint8Array(0)));
    expect(empty?.update.byteLength).toBe(0);
  });

  it('refuses a payload that is cut short', () => {
    expect(decodeSyncReply(Uint8Array.of(0, 0))).toBeNull();
    // Claims ten bytes of update and has two.
    expect(decodeSyncReply(Uint8Array.of(0, 0, 0, 10, 1, 2))).toBeNull();
  });
});
