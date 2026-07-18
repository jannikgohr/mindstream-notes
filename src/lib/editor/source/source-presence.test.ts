import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { Schema, type Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState as ProseEditorState } from '@milkdown/kit/prose/state';
import { EditorView as ProseEditorView } from '@milkdown/kit/prose/view';
import type { Awareness } from 'y-protocols/awareness';
import {
  blockLineStarts,
  computeSourcePresence,
  normalizeColor,
  peerLineMarker,
  topBlockIndexAt
} from './source-presence';
import {
  buildPresenceDecorations,
  setSourcePresence,
  sourcePresence,
  sourcePresenceField,
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

/* --- PeerFlagWidget (via the decorations it lives in) --------------------- */

const flagDoc = 'line0\nline1\nline2\nline3';

/** The name-flag widgets from a presence set, in document order. */
function widgetsOf(presence: PeerPresence[]) {
  const set = buildPresenceDecorations(
    EditorState.create({ doc: flagDoc }),
    presence
  );
  const widgets: {
    toDOM(): HTMLElement;
    eq(o: unknown): boolean;
    ignoreEvent(): boolean;
  }[] = [];
  set.between(0, flagDoc.length, (_from, _to, deco) => {
    const widget = (deco as { spec?: { widget?: unknown } }).spec?.widget;
    if (widget) widgets.push(widget as (typeof widgets)[number]);
  });
  return widgets;
}

describe('PeerFlagWidget', () => {
  it('renders a coloured, aria-hidden name flag', () => {
    const [widget] = widgetsOf([
      { clientId: 1, name: 'Ada', color: '#ff0000', line: 0 }
    ]);
    const el = widget.toDOM();
    expect(el.className).toBe('cm-peer-flag');
    expect(el.textContent).toBe('Ada');
    // happy-dom preserves the hex verbatim (jsdom would normalise to rgb()).
    expect(el.style.backgroundColor).toBe('#ff0000');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it('never handles editor events (ignoreEvent)', () => {
    const [widget] = widgetsOf([
      { clientId: 1, name: 'Ada', color: '#ff0000', line: 0 }
    ]);
    expect(widget.ignoreEvent()).toBe(true);
  });

  it('compares equal for the same name + colour, unequal otherwise', () => {
    const [a] = widgetsOf([
      { clientId: 1, name: 'Ada', color: '#ff0000', line: 0 }
    ]);
    const [aAgain] = widgetsOf([
      { clientId: 9, name: 'Ada', color: '#ff0000', line: 0 }
    ]);
    // eq ignores clientId — only name + colour matter for re-rendering.
    expect(a.eq(aAgain)).toBe(true);

    const two = widgetsOf([
      { clientId: 1, name: 'Ada', color: '#ff0000', line: 0 },
      { clientId: 2, name: 'Bo', color: '#00ff00', line: 1 }
    ]);
    expect(two[0].eq(two[1])).toBe(false);
  });
});

/* --- Presence decode helpers (pure half of computeSourcePresence) -------- */

const proseSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    text: { group: 'inline' }
  }
});

/** A three-paragraph doc: ['aaa', 'bbb', 'ccc']. */
function threeBlockDoc(): ProseNode {
  const p = (t: string) =>
    proseSchema.node('paragraph', null, [proseSchema.text(t)]);
  return proseSchema.node('doc', null, [p('aaa'), p('bbb'), p('ccc')]);
}

/** Document position just inside top-level block `k`. */
function insideBlock(doc: ProseNode, k: number): number {
  let pos = 0;
  for (let i = 0; i < k; i++) pos += doc.child(i).nodeSize;
  return pos + 1; // step past the block's opening boundary
}

describe('normalizeColor', () => {
  it('passes through a 6-digit hex colour', () => {
    expect(normalizeColor('#1a2b3c')).toBe('#1a2b3c');
    expect(normalizeColor('#ABCDEF')).toBe('#ABCDEF');
  });

  it('falls back to the default for anything else', () => {
    expect(normalizeColor('#abc')).toBe('#ffa500'); // 3-digit
    expect(normalizeColor('red')).toBe('#ffa500'); // named
    expect(normalizeColor(undefined)).toBe('#ffa500');
    expect(normalizeColor(0xff0000)).toBe('#ffa500'); // non-string
  });
});

describe('topBlockIndexAt', () => {
  const doc = threeBlockDoc();

  it('resolves a position to its top-level block index', () => {
    expect(topBlockIndexAt(doc, insideBlock(doc, 0))).toBe(0);
    expect(topBlockIndexAt(doc, insideBlock(doc, 1))).toBe(1);
    expect(topBlockIndexAt(doc, insideBlock(doc, 2))).toBe(2);
  });

  it('clamps out-of-range positions into the document', () => {
    expect(topBlockIndexAt(doc, -100)).toBe(0);
    expect(topBlockIndexAt(doc, 9999)).toBe(2); // last block
  });
});

describe('peerLineMarker', () => {
  const doc = threeBlockDoc();
  const lineStarts = blockLineStarts(['aaa', 'bbb', 'ccc']); // [0, 2, 4]

  it('maps a caret to its block’s source line with the peer’s name + colour', () => {
    const marker = peerLineMarker(
      doc,
      insideBlock(doc, 1),
      7,
      { name: '  Ada  ', color: '#00ff00' },
      lineStarts
    );
    expect(marker).toEqual({
      clientId: 7,
      name: 'Ada', // trimmed
      color: '#00ff00',
      line: 2 // block index 1 → line 2
    });
  });

  it('falls back to "User <id>" and the default colour', () => {
    expect(peerLineMarker(doc, 1, 42, undefined, lineStarts)).toMatchObject({
      name: 'User 42',
      color: '#ffa500',
      line: 0
    });
    // Blank name is treated as absent.
    expect(peerLineMarker(doc, 1, 5, { name: '   ' }, lineStarts).name).toBe(
      'User 5'
    );
  });

  it('clamps a caret past the end to the last block, and unknown lines to 0', () => {
    // head beyond the doc → last block (index 2) → line 4.
    expect(peerLineMarker(doc, 9999, 1, {}, lineStarts).line).toBe(4);
    // A block with no entry in lineStarts → 0.
    expect(peerLineMarker(doc, insideBlock(doc, 2), 1, {}, []).line).toBe(0);
  });
});

describe('computeSourcePresence', () => {
  it('returns [] when the editor has no y-prosemirror sync binding', () => {
    // A bare ProseMirror view (no ySyncPlugin) → the guard short-circuits
    // before touching awareness. The live-binding decode path is exercised by
    // the T4 multi-client collab e2e.
    const view = new ProseEditorView(document.createElement('div'), {
      state: ProseEditorState.create({
        schema: proseSchema,
        doc: threeBlockDoc()
      })
    });
    const awareness = {
      getStates: () => new Map()
    } as unknown as Awareness;

    expect(computeSourcePresence(view, awareness, [0, 2, 4])).toEqual([]);
    view.destroy();
  });
});

/* --- sourcePresenceField + the composed extension ------------------------ */

describe('sourcePresenceField', () => {
  const peer: PeerPresence = {
    clientId: 1,
    name: 'A',
    color: '#ff0000',
    line: 1
  };

  it('starts empty, fills on the effect, survives edits, and clears', () => {
    // create() → Decoration.none
    let state = EditorState.create({
      doc: 'a\nb\nc',
      extensions: [sourcePresence()]
    });
    expect(state.field(sourcePresenceField).size).toBe(0);

    // setSourcePresence effect → rebuild (line stripe + name flag = 2).
    state = state.update({
      effects: setSourcePresence.of([peer])
    }).state;
    expect(state.field(sourcePresenceField).size).toBe(2);

    // A plain edit (no effect) maps the markers through the change; they stay.
    state = state.update({ changes: { from: 0, insert: 'X' } }).state;
    expect(state.field(sourcePresenceField).size).toBe(2);

    // An empty presence effect clears them.
    state = state.update({ effects: setSourcePresence.of([]) }).state;
    expect(state.field(sourcePresenceField).size).toBe(0);
  });
});
