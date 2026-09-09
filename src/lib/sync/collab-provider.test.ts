import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate } from 'y-protocols/awareness';
import { CollabProvider } from './collab-provider';

afterEach(() => vi.unstubAllGlobals());

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
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const peerDoc = new Y.Doc();
    const peer = new Awareness(peerDoc);
    const provider = new CollabProvider({
      doc,
      awareness,
      roomId: 'room',
      url: 'ws://relay',
      keyBytes: new Uint8Array(32)
    });
    const send = vi
      .spyOn(
        provider as unknown as {
          send(type: number, payload: Uint8Array): Promise<void>;
        },
        'send'
      )
      .mockResolvedValue(undefined);
    for (let cursor = 0; cursor < 100; cursor += 1)
      awareness.setLocalState({ cursor });
    expect(request).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    nextFrame(0);
    expect(send).toHaveBeenCalledTimes(1);
    const [type, payload] = send.mock.calls[0];
    expect(type).toBe(2);
    applyAwarenessUpdate(peer, payload, 'test');
    expect(peer.getStates().get(doc.clientID)).toEqual({ cursor: 99 });
    awareness.setLocalState({ cursor: 100 });
    provider.destroy();
    expect(cancel).toHaveBeenCalledWith(1);
    nextFrame(1);
    expect(send).toHaveBeenCalledTimes(1);
    awareness.destroy();
    peer.destroy();
    doc.destroy();
    peerDoc.destroy();
    await Promise.resolve();
  });
});
