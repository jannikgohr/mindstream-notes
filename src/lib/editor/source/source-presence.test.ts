import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { blockLineStarts } from './source-presence';
import {
  buildPresenceDecorations,
  type PeerPresence
} from './source-presence-extension';

describe('blockLineStarts', () => {
  it('maps each block index to its starting line', () => {
    // '# A'(1) + blank + 'para'(1) + blank + '- a\n- b'(2)
    expect(blockLineStarts(['# A', 'para', '- a\n- b'])).toEqual([0, 2, 4]);
  });

  it('counts a multi-line block before the next start', () => {
    // '```\nx\n```' is 3 lines → next block starts at line 4 (3 + separator)
    expect(blockLineStarts(['```\nx\n```', 'end'])).toEqual([0, 4]);
  });

  it('treats an empty block as one line', () => {
    expect(blockLineStarts(['', ''])).toEqual([0, 2]);
  });

  it('returns [] for no blocks', () => {
    expect(blockLineStarts([])).toEqual([]);
  });
});

describe('buildPresenceDecorations', () => {
  const doc = 'line0\nline1\nline2\nline3';
  const state = () => EditorState.create({ doc });

  function froms(presence: PeerPresence[]): number[] {
    const set = buildPresenceDecorations(state(), presence);
    const out: number[] = [];
    set.between(0, doc.length, (from) => {
      out.push(from);
    });
    return out;
  }

  it('anchors a peer at the start of its mapped line', () => {
    // line index 2 starts at offset 12 ("line0\nline1\n").
    expect(
      froms([{ clientId: 1, name: 'Ada', color: '#ff0000', line: 2 }])
    ).toContain(12);
  });

  it('clamps an out-of-range line into the document', () => {
    // Last line (index 3) starts at offset 18.
    expect(
      froms([{ clientId: 1, name: 'X', color: '#00ff00', line: 999 }])
    ).toContain(18);
  });

  it('emits a line stripe + name flag per peer', () => {
    const set = buildPresenceDecorations(state(), [
      { clientId: 1, name: 'X', color: '#0000ff', line: 0 }
    ]);
    expect(set.size).toBe(2);
  });

  it('is empty with no peers', () => {
    expect(buildPresenceDecorations(state(), []).size).toBe(0);
  });

  it('orders multiple peers on the same line without throwing', () => {
    const set = buildPresenceDecorations(state(), [
      { clientId: 2, name: 'B', color: '#111111', line: 1 },
      { clientId: 1, name: 'A', color: '#222222', line: 1 }
    ]);
    expect(set.size).toBe(4);
  });
});
