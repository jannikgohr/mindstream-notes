import { describe, expect, it } from 'vitest';
import type { Awareness } from 'y-protocols/awareness';
import { otherPeerCount } from './awareness-presence';

describe('otherPeerCount', () => {
  it('returns zero without awareness', () => {
    expect(otherPeerCount(null)).toBe(0);
  });

  it('counts only remote clients', () => {
    const awareness = {
      clientID: 2,
      getStates: () =>
        new Map([
          [1, {}],
          [2, {}],
          [3, {}]
        ])
    } as unknown as Awareness;

    expect(otherPeerCount(awareness)).toBe(2);
  });
});
