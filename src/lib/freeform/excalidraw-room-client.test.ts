import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import {
  ADMIN,
  FakeRoomServer,
  READ_ONLY,
  READ_WRITE,
  settle,
  trackCrypto
} from '$lib/sync/fake-room-server';
import { ROOM_CLASS_UPDATE } from '$lib/sync/room-socket';
import {
  ExcalidrawRoomClient,
  reconcileElements,
  sceneFingerprint
} from './excalidraw-room-client';

// The real package pulls in React and a canvas. The client needs one
// constant from it.
vi.mock('@excalidraw/excalidraw', () => ({
  CaptureUpdateAction: { NEVER: 'never' }
}));

const KEY = new Uint8Array(32).fill(11);

function element(id: string, version = 1, versionNonce = 1): ExcalidrawElement {
  return { id, version, versionNonce, isDeleted: false } as ExcalidrawElement;
}

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A canvas with just enough of Excalidraw's API for the client. */
function canvas(username: string, accessLevel: number, initial: string[] = []) {
  let elements: readonly ExcalidrawElement[] = initial.map((id) => element(id));
  const listeners = new Set<() => void>();
  let remoteUpdates = 0;
  const api = {
    onChange(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSceneElementsIncludingDeleted: () => elements,
    updateScene(scene: { elements: readonly ExcalidrawElement[] }) {
      remoteUpdates += 1;
      elements = scene.elements;
      // Excalidraw reports every scene change, including ones it was
      // handed. That report is what an echo loop would feed on.
      for (const listener of listeners) listener();
    }
  } as unknown as ExcalidrawImperativeAPI;
  return {
    ids: () => elements.map((el) => `${el.id}@${el.version}`).sort(),
    remoteUpdates: () => remoteUpdates,
    /** Draw or change something locally. */
    draw(id: string, version = 1) {
      elements = [
        ...elements.filter((el) => el.id !== id),
        element(id, version, version)
      ];
      for (const listener of listeners) listener();
    },
    open() {
      const client = new ExcalidrawRoomClient({
        api,
        url: 'ws://server/api/v1/room/',
        keyBytes: KEY,
        getTicket: async () => server.ticket(username, accessLevel)
      });
      cleanup.push(() => client.destroy());
      return client;
    }
  };
}

function scenesSent(): number {
  return server.received.filter(({ frame }) => frame[0] === ROOM_CLASS_UPDATE)
    .length;
}

describe('live freeform sync', () => {
  it('hands a joining device the scene and carries changes both ways', async () => {
    const ann = canvas('ann', ADMIN, ['a']);
    const bob = canvas('bob', READ_WRITE);
    ann.open();
    await settle();
    bob.open();
    await settle();
    expect(bob.ids()).toEqual(['a@1']);
    // The scene went to the member who asked, not out to the room.
    expect(scenesSent()).toBe(0);

    bob.draw('b');
    await settle();
    expect(ann.ids()).toEqual(['a@1', 'b@1']);

    ann.draw('a', 2);
    await settle();
    expect(bob.ids()).toEqual(['a@2', 'b@1']);
  });

  it('delivers what a device drew while it was away, and then goes quiet', async () => {
    const ann = canvas('ann', ADMIN, ['a']);
    const bob = canvas('bob', READ_WRITE, ['offline']);
    ann.open();
    await settle();
    bob.open();
    await settle();

    expect(ann.ids()).toEqual(['a@1', 'offline@1']);
    expect(bob.ids()).toEqual(['a@1', 'offline@1']);
    // One scene to close the gap. Not a scene per side for ever after.
    const sent = scenesSent();
    expect(sent).toBe(1);
    await settle();
    expect(scenesSent()).toBe(sent);
    expect(ann.remoteUpdates()).toBe(1);
  });

  it('lets a member who may only read watch, and sends nothing of its own', async () => {
    const reader = canvas('reader', READ_ONLY);
    const ann = canvas('ann', ADMIN, ['a']);
    // There first, and unable to answer when the writer asks for a scene.
    reader.open();
    await settle();
    ann.open();
    await settle();
    expect(reader.ids()).toEqual(['a@1']);

    reader.draw('scribble');
    await settle();
    expect(ann.ids()).toEqual(['a@1']);
    expect(scenesSent()).toBe(0);
  });

  it('sends the latest scene, not one per stroke point', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const ann = canvas('ann', ADMIN);
    const bob = canvas('bob', READ_WRITE);
    ann.open();
    bob.open();
    await settle();

    for (let version = 1; version <= 20; version += 1)
      ann.draw('line', version);
    await settle();
    await vi.advanceTimersByTimeAsync(60);
    await settle();

    expect(scenesSent()).toBe(2);
    expect(bob.ids()).toEqual(['line@20']);
  });

  it('ignores a frame that is not a scene', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ann = canvas('ann', ADMIN, ['a']);
    const bob = canvas('bob', READ_WRITE, ['a']);
    ann.open();
    const client = bob.open();
    await settle();
    const socket = (
      client as unknown as {
        socket: { send(cls: number, payload: Uint8Array): Promise<void> };
      }
    ).socket;
    await socket.send(ROOM_CLASS_UPDATE, new TextEncoder().encode('{not json'));
    await socket.send(
      ROOM_CLASS_UPDATE,
      new TextEncoder().encode('{"type":"MOUSE_LOCATION","payload":{}}')
    );
    await settle();
    expect(ann.ids()).toEqual(['a@1']);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('reconciling scenes', () => {
  it('keeps the newer version of each element and the remote order', () => {
    const merged = reconcileElements(
      [element('a', 3), element('b', 1), element('mine', 1)],
      [element('b', 2), element('a', 2)]
    );
    expect(merged.map((el) => `${el.id}@${el.version}`)).toEqual([
      'b@2',
      'a@3',
      'mine@1'
    ]);
  });

  it('keeps the local object when the two are the same', () => {
    const local = element('a', 2, 7);
    const merged = reconcileElements([local], [element('a', 2, 7)]);
    expect(merged[0]).toBe(local);
  });

  it('fingerprints order, versions and deletion', () => {
    const a = element('a');
    const b = element('b');
    expect(sceneFingerprint([a, b])).not.toBe(sceneFingerprint([b, a]));
    expect(sceneFingerprint([a])).not.toBe(sceneFingerprint([element('a', 2)]));
    expect(sceneFingerprint([a])).not.toBe(
      sceneFingerprint([{ ...a, isDeleted: true } as ExcalidrawElement])
    );
    expect(sceneFingerprint([a, b])).toBe(
      sceneFingerprint([element('a'), element('b')])
    );
  });
});
