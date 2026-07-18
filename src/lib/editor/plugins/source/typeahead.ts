/**
 * The autocomplete-popup machinery shared by the source surface's wikilink
 * and user-mention plugins.
 *
 * Both are the same extension wearing different hats: watch for a trigger
 * marker before the caret, publish the query + caret position to a bridge so
 * the popup component can render, intercept the navigation keys while it's
 * open, and replace the trigger span with markdown when the user commits.
 * Only three things differ — the marker, where the replaced span ends, and
 * what markdown gets emitted — so those are the config and everything else
 * lives here. (The WYSIWYG side duplicates this structure across
 * `../prose/wikilink.ts` and `../prose/user-mention.ts`, which is why the
 * latter opens by describing itself as a trimmed sibling of the former.)
 *
 * The popup components are surface-agnostic — they only read `bridge.state`
 * — so they render for the source surface without modification. The host
 * creates a SEPARATE bridge per surface: in Split mode both editors are live
 * at once, and a bridge holds exactly one set of commit handlers, so a shared
 * one would let whichever surface registered last steal the other's commits.
 * Two bridges, two popup instances, and the focused pane is the only one that
 * ever opens its menu.
 *
 * Unlike the prose trigger plugin, which keeps its `startPos` in plugin state
 * and maps it through every transaction, this recomputes the trigger from the
 * document and selection on each update. `findStart` is pure and cheap
 * (bounded by a lookback window), and a value derived on demand can't drift
 * out of sync with the text the way a mapped position can. The only thing
 * worth remembering across transactions is an explicit dismissal.
 */

import { EditorView, ViewPlugin, keymap } from '@codemirror/view';
import {
  EditorSelection,
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension
} from '@codemirror/state';
import type { CaretRect } from '../wikilink-bridge.svelte';

/**
 * The slice of a bridge this machinery needs. Both `WikilinkBridge` and
 * `UserMentionBridge` satisfy it structurally (their extra members — the
 * mention bridge's `users`, each one's `insert`/`cancel` — are simply not our
 * business), which is what lets one implementation drive both.
 */
export interface SourceTypeaheadBridge<T> {
  state: {
    open: boolean;
    query: string;
    caretRect: CaretRect | null;
    highlight: number;
  };
  setHandlers(handlers: {
    insert: (item: T) => void;
    cancel: () => void;
  }): void;
  commitFromPopup(): void;
}

export interface SourceTypeaheadConfig<T> {
  bridge: SourceTypeaheadBridge<T>;
  /** Characters in the trigger marker — `[[` is 2, `@` is 1. The query is the
   *  text between the marker and the caret. */
  markerLength: number;
  /** Document position of the trigger marker's FIRST character when the caret
   *  sits inside its query, else null. Must be pure — it runs on every
   *  update. */
  findStart(state: EditorState, cursor: number): number | null;
  /** Where the replaced span ends on commit. At least `cursor`; more when the
   *  caret is in the middle of an already-complete trigger, so committing
   *  replaces the whole thing instead of leaving its tail behind. */
  findReplaceTo(state: EditorState, start: number, cursor: number): number;
  /** The markdown a committed item becomes. */
  render(item: T): string;
}

interface TypeaheadState {
  /** Position of the trigger marker; null when no menu should be open. */
  start: number | null;
  /**
   * A trigger the user pressed Escape on, suppressed until they leave it.
   * Without this, Escape would close the menu only for the instant before the
   * next keystroke recomputed the very same trigger and reopened it.
   */
  dismissed: number | null;
}

const CLOSED: TypeaheadState = { start: null, dismissed: null };

function caretRectAt(view: EditorView, pos: number): CaretRect | null {
  const c = view.coordsAtPos(pos);
  if (!c) return null;
  // Zero-width rect at the caret's left edge — the popup hands this to
  // floating-ui as a virtual element, so positioning survives transformed
  // ancestors (dockview panels) without us re-deriving coordinates.
  return {
    top: c.top,
    bottom: c.bottom,
    left: c.left,
    right: c.left,
    width: 0,
    height: c.bottom - c.top
  };
}

/**
 * Build a typeahead extension. Register only when the owning feature's setting
 * is on — the same toggle that gates the matching prose plugin.
 */
export function sourceTypeahead<T>(
  config: SourceTypeaheadConfig<T>
): Extension {
  const { bridge } = config;

  // Defined per instance, not per module: wikilink and mention typeaheads are
  // both registered on the same editor, and a shared effect would let one's
  // Escape dismiss the other's menu.
  const dismiss = StateEffect.define<null>();

  const field = StateField.define<TypeaheadState>({
    create: () => CLOSED,
    update(prev, tr) {
      let dismissed =
        prev.dismissed === null ? null : tr.changes.mapPos(prev.dismissed);
      if (tr.effects.some((e) => e.is(dismiss)) && prev.start !== null) {
        dismissed = tr.changes.mapPos(prev.start);
      }

      const sel = tr.state.selection.main;
      // A non-empty selection means the user is selecting text, not composing
      // a query. Multiple carets have no single query to show.
      const found =
        sel.empty && tr.state.selection.ranges.length === 1
          ? config.findStart(tr.state, sel.head)
          : null;
      // Left the trigger entirely → re-arm, so coming back reopens.
      if (found === null) return CLOSED;
      if (found === dismissed) return { start: null, dismissed };
      return { start: found, dismissed: null };
    }
  });

  function resetBridge() {
    bridge.state.open = false;
    bridge.state.query = '';
    bridge.state.caretRect = null;
    bridge.state.highlight = 0;
  }

  function close(view: EditorView) {
    resetBridge();
    view.dispatch({ effects: dismiss.of(null) });
  }

  function insert(view: EditorView, item: T) {
    const start = view.state.field(field).start;
    if (start === null) {
      close(view);
      return;
    }
    const cursor = view.state.selection.main.head;
    const text = config.render(item);
    view.dispatch({
      changes: {
        from: start,
        to: config.findReplaceTo(view.state, start, cursor),
        insert: text
      },
      selection: EditorSelection.cursor(start + text.length),
      scrollIntoView: true,
      userEvent: 'input.complete'
    });
    // The inserted markdown ends in `)`, and every findStart aborts before
    // scanning past it, so the recompute above already closed the menu. Reset
    // the bridge anyway rather than rely on that: this is the commit path, and
    // a menu left open over a completed link would be a bad failure.
    resetBridge();
    view.focus();
  }

  /**
   * Publish the caret rect the popup anchors to.
   *
   * This has to go through `requestMeasure` rather than just reading
   * `coordsAtPos` where we need it: that's a layout read, and CodeMirror
   * throws "Reading the editor layout isn't allowed during an update" if one
   * happens inside a view plugin's `update`. The measure cycle is the sanctioned
   * place for it. Everything else about the menu is derived from the document,
   * so only the rect is deferred — it lands a frame after `open` flips, which
   * the popup already handles (it renders invisible until floating-ui has
   * positioned it).
   */
  function measureCaret(view: EditorView) {
    view.requestMeasure({
      read: (v) => {
        // Re-read rather than closing over the position: an edit could have
        // landed between scheduling this and the measure cycle running.
        if (v.state.field(field).start === null) return null;
        return caretRectAt(v, v.state.selection.main.head);
      },
      write: (rect) => {
        // A null rect means the caret isn't drawn (scrolled out of the
        // rendered viewport) or the menu closed while we waited — either way
        // there's nowhere to anchor, so leave the last rect in place rather
        // than putting the popup somewhere arbitrary.
        if (rect) bridge.state.caretRect = rect;
      }
    });
  }

  // The bridge is wired once per view rather than once per extension: the
  // handlers need a view to act on, and only the plugin has one.
  const syncPlugin = ViewPlugin.define((view) => {
    bridge.setHandlers({
      insert: (item) => insert(view, item),
      cancel: () => close(view)
    });

    return {
      update(u) {
        const { start } = u.state.field(field);
        if (start === null) {
          if (bridge.state.open) resetBridge();
          return;
        }
        const cursor = u.state.selection.main.head;
        const query = u.state.doc.sliceString(
          start + config.markerLength,
          cursor
        );
        // Only reset the highlight when the query actually changes, so arrow
        // navigation isn't clobbered by an unrelated update (a resize, a
        // remote edit elsewhere in the document).
        if (!bridge.state.open || bridge.state.query !== query) {
          bridge.state.highlight = 0;
        }
        bridge.state.open = true;
        bridge.state.query = query;
        measureCaret(u.view);
      },
      destroy() {
        resetBridge();
      }
    };
  });

  const keys = Prec.highest(
    keymap.of([
      { key: 'Escape', run: menuKey((view) => close(view)) },
      { key: 'Enter', run: menuKey(() => bridge.commitFromPopup()) },
      // Tab commits too — the convention in most typeahead UIs, and it stops
      // the source editor's indent binding from firing under an open menu.
      { key: 'Tab', run: menuKey(() => bridge.commitFromPopup()) },
      {
        key: 'ArrowDown',
        run: menuKey(() => {
          bridge.state.highlight = bridge.state.highlight + 1;
        })
      },
      {
        key: 'ArrowUp',
        run: menuKey(() => {
          bridge.state.highlight = Math.max(0, bridge.state.highlight - 1);
        })
      }
    ])
  );

  /** Run `fn` only while this typeahead's menu is open; otherwise decline the
   *  key so the editor's normal binding (newline, indent, caret move) runs. */
  function menuKey(fn: (view: EditorView) => void) {
    return (view: EditorView) => {
      if (view.state.field(field).start === null) return false;
      fn(view);
      return true;
    };
  }

  return [field, syncPlugin, keys];
}
