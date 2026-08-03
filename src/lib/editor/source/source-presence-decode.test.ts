import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Awareness } from 'y-protocols/awareness';
import type { EditorView } from '@milkdown/kit/prose/view';

// The decode loop in computeSourcePresence needs a live y-prosemirror sync
// binding to exist. We mock the binding-state accessor + relative-position
// decode so the loop (self-skip, missing-cursor skip, decode-throw skip, and a
// successful decode) is exercised without a real collab document.
const y = vi.hoisted(() => ({
  getState: vi.fn(),
  rpToAbs: vi.fn()
}));
vi.mock('y-prosemirror', () => ({
  ySyncPluginKey: { getState: y.getState },
  relativePositionToAbsolutePosition: y.rpToAbs
}));
vi.mock('yjs', () => ({
  createRelativePositionFromJSON: (x: unknown) => x
}));

import { computeSourcePresence } from './source-presence';

// Minimal ProseMirror doc surface topBlockIndexAt/peerLineMarker touch.
const fakeDoc = {
  content: { size: 12 },
  childCount: 3,
  resolve: () => ({ index: () => 1 })
};
const view = { state: { doc: fakeDoc } } as unknown as EditorView;

function awarenessFrom(states: Map<number, unknown>): Awareness {
  return { getStates: () => states } as unknown as Awareness;
}

function boundState(over: Record<string, unknown> = {}) {
  return {
    binding: { mapping: new Map([['a', 1]]) },
    snapshot: null,
    prevSnapshot: null,
    doc: { clientID: 100 },
    type: {},
    ...over
  };
}

beforeEach(() => {
  y.getState.mockReset();
  y.rpToAbs.mockReset();
});

describe('computeSourcePresence — decode loop', () => {
  it('returns [] when the binding has no mapping yet', () => {
    y.getState.mockReturnValue(boundState({ binding: { mapping: new Map() } }));
    expect(
      computeSourcePresence(view, awarenessFrom(new Map()), [0, 2, 4])
    ).toEqual([]);
  });

  it('returns [] while a snapshot is active', () => {
    y.getState.mockReturnValue(boundState({ snapshot: {} }));
    expect(
      computeSourcePresence(view, awarenessFrom(new Map()), [0, 2, 4])
    ).toEqual([]);
  });

  it('decodes a remote peer, skipping self and cursorless/failed peers', () => {
    y.getState.mockReturnValue(boundState());
    y.rpToAbs.mockImplementation((_doc, _type, rel: unknown) => {
      if (rel === 'boom') throw new Error('bad relative position');
      return 3; // absolute head position
    });
    const states = new Map<number, unknown>([
      [100, { cursor: { head: 'x' } }], // self → skipped
      [1, { cursor: { head: 'ok' }, user: { name: 'Ada', color: '#00ff00' } }],
      [2, {}], // no cursor → skipped
      [3, { cursor: {} }], // cursor without head → skipped
      [4, { cursor: { head: 'boom' } }] // decode throws → skipped
    ]);

    const out = computeSourcePresence(view, awarenessFrom(states), [0, 2, 4]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      clientId: 1,
      name: 'Ada',
      color: '#00ff00'
    });
  });
});
