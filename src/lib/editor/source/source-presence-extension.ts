/**
 * CodeMirror extension that renders remote collaborators' presence in the
 * raw-source view.
 *
 * Phase 2 (lightweight): we do NOT bind CodeMirror to a second Yjs structure.
 * Instead NoteEditor decodes the cursor each peer already broadcasts (see
 * `source-presence.ts`) to an approximate source LINE and pushes the resulting
 * `PeerPresence[]` in via the `setSourcePresence` effect. Each peer renders as a
 * coloured name flag at the start of their line plus a left-edge line stripe, so
 * the marker is line-granular — enough to see "who is where" without the
 * divergence risk of a shared editable Y.Text.
 */

import { StateEffect, StateField, type Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet
} from '@codemirror/view';

/** One remote collaborator's mapped position in the source view. */
export interface PeerPresence {
  /** Yjs awareness client id — stable per peer, used as the decoration key. */
  clientId: number;
  name: string;
  /** CSS colour string (peer's awareness colour). */
  color: string;
  /** 0-based line the peer's caret maps to. Clamped to the doc on render. */
  line: number;
}

/** Replace the whole set of remote presence markers. */
export const setSourcePresence = StateEffect.define<PeerPresence[]>();

/** A small coloured flag showing the peer's name, rendered at line start. */
class PeerFlagWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly color: string
  ) {
    super();
  }
  eq(other: PeerFlagWidget): boolean {
    return other.name === this.name && other.color === this.color;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-peer-flag';
    el.textContent = this.name;
    el.style.backgroundColor = this.color;
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Build the decoration set for `presence` against `state`. Pure (given the
 * state) so it can be unit-tested without a live view. Each peer contributes a
 * line-stripe decoration and a name-flag widget, both anchored at the start of
 * their (clamped) line. Multiple peers on one line stack in client-id order.
 */
export function buildPresenceDecorations(
  state: { doc: { lines: number; line: (n: number) => { from: number } } },
  presence: PeerPresence[]
): DecorationSet {
  const lineCount = state.doc.lines;
  const ranges: Range<Decoration>[] = [];
  // Sort by (line, clientId) so the RangeSet is well-ordered and stacking is
  // deterministic when several peers share a line.
  const sorted = [...presence].sort(
    (a, b) => a.line - b.line || a.clientId - b.clientId
  );
  for (const p of sorted) {
    const ln = Math.min(Math.max(p.line, 0), lineCount - 1);
    const from = state.doc.line(ln + 1).from;
    // Line stripe first (startSide is very negative for line decorations), then
    // the inline flag widget at the same position.
    ranges.push(
      Decoration.line({
        attributes: { style: `box-shadow: inset 2px 0 0 0 ${p.color}` }
      }).range(from)
    );
    ranges.push(
      Decoration.widget({
        widget: new PeerFlagWidget(p.name, p.color),
        side: -1,
        key: p.clientId
      }).range(from)
    );
  }
  // `true` → let CodeMirror sort the mixed line/widget ranges into RangeSet order.
  return Decoration.set(ranges, true);
}

/** Holds the current remote-presence decorations, replaced on each effect and
 *  mapped through document changes in between so markers track edits. */
export const sourcePresenceField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setSourcePresence)) {
        return buildPresenceDecorations(tr.state, effect.value);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f)
});

/** Base styling for the peer name flag. Kept with the extension so the source
 *  editor is self-contained. */
const presenceTheme = EditorView.baseTheme({
  '.cm-peer-flag': {
    display: 'inline-block',
    margin: '0 4px 0 0',
    padding: '0 4px',
    borderRadius: '3px',
    fontSize: '0.7em',
    lineHeight: '1.4',
    fontFamily: 'system-ui, sans-serif',
    color: '#fff',
    verticalAlign: 'text-top',
    userSelect: 'none',
    pointerEvents: 'none',
    whiteSpace: 'nowrap'
  }
});

/** The composed extension to add to the source editor. */
export function sourcePresence() {
  return [sourcePresenceField, presenceTheme];
}
