/**
 * Rendering text diagnostics in the WYSIWYG surface.
 *
 * The plugin owns three jobs and delegates the fourth: it cuts the document
 * into checkable segments, decides which parts are not prose, draws the
 * results, and hands the actual checking to whatever `check` it was given
 * (in practice the diagnostics bus). It never mutates the document — with
 * Yjs underneath, a checker that edits text would fight collaborative
 * updates, so corrections are applied only by explicit user action.
 *
 * WHY NOT `ignore-ranges` HERE: the source surface has to recover structure
 * by re-parsing Markdown text. This surface already has it. A `code_block`
 * node is unambiguously code; a `code` mark is unambiguously inline code.
 * Using the document rather than a regex is both cheaper and exact, so the
 * two surfaces deliberately answer the same question by different means.
 */

import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { Transaction } from '@milkdown/kit/prose/state';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView } from '@milkdown/kit/prose/view';
import { excludeIgnored } from '$lib/diagnostics/ignore-ranges';
import { isAbortError } from '$lib/diagnostics/bus';
import type { Diagnostic, Segment, TextRange } from '$lib/diagnostics/types';
import type { DiagnosticMenuContext } from '$lib/diagnostics/popover-bridge.svelte';
import { parseNoteHref } from '../wikilink-href';
import { parseUserHref } from '../user-mention-href';

/**
 * Both the drawn squiggles and the diagnostics behind them.
 *
 * Held together and mapped together. An earlier version kept the
 * diagnostics in a closure variable beside the mapped DecorationSet, so
 * after any edit the decorations moved with the text while the array kept
 * pre-edit positions — right-click then hit-tested against stale ranges and
 * applying a suggestion wrote to the wrong place, or nowhere.
 */
export interface DiagnosticsState {
  diagnostics: Diagnostic[];
  deco: DecorationSet;
}

export const diagnosticsPluginKey = new PluginKey<DiagnosticsState>(
  'diagnostics'
);

/**
 * Stands in for a non-text inline node (image, inline math) when flattening a
 * block to a string.
 *
 * It must be exactly ONE character wide: ProseMirror counts every leaf node as
 * a single position, so a one-char placeholder keeps string offsets and
 * document positions in lockstep and the plugin never has to translate
 * between the two. U+FFFC is the Unicode "object replacement character" and
 * is not a letter, so the tokenizer skips it rather than reporting it as a
 * misspelling.
 */
const LEAF_PLACEHOLDER = String.fromCharCode(0xfffc);

/** Marks whose text is not free prose and should not be checked. */
const SKIPPED_MARKS = new Set(['code', 'inlineCode']);

/**
 * Link marks are skipped only when they point at another note or a user —
 * those render as a wikilink or an @mention, where the visible text is an
 * identifier the user did not write as prose. An ordinary external link's
 * text IS prose and stays checked.
 *
 * Goes through the shared href parsers rather than matching the scheme
 * here: the on-disk format (`mindstream://note/<id>`, percent-encoded) is
 * their contract to own, and duplicating it is how the two drift apart.
 */
function isInternalLink(href: unknown): boolean {
  return parseNoteHref(href) !== null || parseUserHref(href) !== null;
}

export interface DocumentAnalysis {
  segments: Segment[];
  /** Positions inside segments that must not produce diagnostics. */
  skips: TextRange[];
}

/**
 * Flatten the document into one segment per textblock, plus the ranges
 * within them that are not prose.
 *
 * Segments are per-block rather than per-document because that is what makes
 * caching pay off: editing one paragraph invalidates one cache entry.
 */
export function analyzeDocument(doc: ProseNode): DocumentAnalysis {
  const segments: Segment[] = [];
  const skips: TextRange[] = [];

  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;

    // Code blocks are excluded wholesale rather than checked and filtered:
    // they are usually the largest non-prose regions in a note, so not
    // sending them at all is the difference that matters for a network
    // checker like LanguageTool.
    if (node.type.spec.code) return false;

    // +1 steps inside the block, so `base` is the document position of the
    // block's first character and string offsets add directly to it.
    const base = pos + 1;
    const text = node.textBetween(0, node.content.size, ' ', LEAF_PLACEHOLDER);
    if (text.trim().length > 0) {
      segments.push({ text, from: base, to: base + text.length });
    }

    node.descendants((child, childPos) => {
      if (!child.isText) return true;
      const skipped = child.marks.some(
        (mark) =>
          SKIPPED_MARKS.has(mark.type.name) ||
          (mark.type.name === 'link' && isInternalLink(mark.attrs.href))
      );
      if (skipped) {
        skips.push({
          from: base + childPos,
          to: base + childPos + child.nodeSize
        });
      }
      return true;
    });

    // Textblocks do not nest, so there is nothing below this one to visit.
    return false;
  });

  return { segments, skips };
}

/**
 * Diagnostics whose range actually exists in this document.
 *
 * Applied to the STORED list, not just the drawn one. Decorations used to
 * filter while the state kept everything, so a stale out-of-range finding
 * stayed clickable and `insertText` threw on it — which looks exactly like
 * a suggestion that does nothing.
 */
export function withinDocument(
  doc: ProseNode,
  diagnostics: Diagnostic[]
): Diagnostic[] {
  return diagnostics.filter(
    (d) => d.from >= 0 && d.to <= doc.content.size && d.from < d.to
  );
}

/** Build the decoration set drawn for a list of diagnostics. */
export function diagnosticDecorations(
  doc: ProseNode,
  diagnostics: Diagnostic[]
): DecorationSet {
  const decorations = withinDocument(doc, diagnostics).map((d) =>
    Decoration.inline(d.from, d.to, {
      class: `cm-diagnostic diagnostic-${d.kind}`,
      'data-diagnostic-source': d.source,
      'data-diagnostic-kind': d.kind
    })
  );
  return DecorationSet.create(doc, decorations);
}

export interface ProseDiagnosticsOptions {
  /**
   * Runs the check. Returning positions relative to the document (the bus
   * has already rebased them by each segment's offset).
   */
  check(segments: Segment[], signal: AbortSignal): Promise<Diagnostic[]>;
  /**
   * How long to wait after the last keystroke. Long enough that typing a
   * word does not fire a check per character, short enough that the squiggle
   * feels like a reaction to stopping rather than a delayed batch job.
   */
  debounceMs?: number;
  /**
   * Whether checking is currently on. Read at check time, not at
   * construction: Crepe cannot add or remove a plugin after `create()`,
   * so the plugin is always registered and asks each time instead. That
   * is what lets the setting take effect on notes that are already open.
   *
   * When it returns false the plugin clears what it drew rather than
   * merely stopping — leaving stale squiggles behind after the user turns
   * the feature off is worse than never having drawn them.
   */
  enabled?(): boolean;
  /**
   * Subscribe to "your results are stale" notifications, returning an
   * unsubscribe.
   *
   * The plugin can see the document change; it cannot see the language
   * selection change or a dictionary get installed. Without this the
   * squiggles from the previous configuration survive until the next
   * keystroke — which is how enabling German left every German word
   * underlined, each one 'correcting' to its own spelling.
   */
  subscribeInvalidate?(recheck: () => void): () => void;
  /**
   * Called when the document changes while a menu is open.
   *
   * A suggestion's range is only valid against the document it was offered
   * for. Rather than re-mapping a menu already on screen, it is dismissed —
   * which is what any context menu does when the thing beneath it moves.
   */
  onDismissMenu?(): void;
  /**
   * Called when the user right-clicks a diagnostic, to open the popover.
   *
   * `apply` is supplied by the plugin rather than the caller because only
   * the plugin knows how to write to its own surface — and the popover is
   * shared between two surfaces with completely different edit APIs.
   */
  onRequestMenu?(
    diagnostic: Diagnostic,
    event: MouseEvent,
    context: DiagnosticMenuContext
  ): void;
}

const DEFAULT_DEBOUNCE_MS = 400;

export function diagnosticsPlugin(
  options: ProseDiagnosticsOptions
): Plugin<DiagnosticsState> {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;

  /**
   * Transaction mappings collected while a check is in flight.
   *
   * A network check takes seconds, and a note being opened keeps changing
   * while its content loads. Discarding results because the document moved
   * meant the first several checks were thrown away and the user waited for
   * the document to go quiet before seeing anything. Results are mapped
   * forward instead.
   */
  let inflight: {
    maps: { map(pos: number, assoc?: number): number }[];
  } | null = null;
  /** An edit arrived mid-check, so run once more when this one lands. */
  let rerun = false;

  /** Carry a position through every edit that happened during the check. */
  const forward = (pos: number, assoc: number) =>
    (inflight?.maps ?? []).reduce((at, mapping) => mapping.map(at, assoc), pos);

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
  };

  async function run(view: EditorView) {
    // Single-flight. Starting a second request while one is outstanding
    // just multiplies load on a server that already takes seconds; the
    // trailing re-run picks up whatever changed meanwhile.
    if (inflight) {
      rerun = true;
      return;
    }
    if (options.enabled && !options.enabled()) {
      // Clear rather than return: the user may have just switched it off.
      const drawn = diagnosticsPluginKey.getState(view.state)?.diagnostics;
      if (drawn && drawn.length > 0) {
        view.dispatch(view.state.tr.setMeta(diagnosticsPluginKey, []));
      }
      return;
    }
    controller = new AbortController();
    const { signal } = controller;
    inflight = { maps: [] };
    const { segments, skips } = analyzeDocument(view.state.doc);

    try {
      const diagnostics = await options.check(segments, signal);
      if (signal.aborted || view.isDestroyed) return;

      // Both are in the coordinates of the document as it was when the
      // check started, so filter first and move the survivors afterwards.
      const kept = excludeIgnored(diagnostics, skips);
      const moved = kept.map((d) => ({
        ...d,
        from: forward(d.from, 1),
        to: forward(d.to, -1)
      }));
      view.dispatch(view.state.tr.setMeta(diagnosticsPluginKey, moved));
    } catch (err) {
      if (!isAbortError(err)) console.error('Diagnostics check failed', err);
    } finally {
      inflight = null;
      if (rerun && !view.isDestroyed) {
        rerun = false;
        void run(view);
      }
    }
  }

  return new Plugin<DiagnosticsState>({
    key: diagnosticsPluginKey,
    state: {
      init: () => ({ diagnostics: [], deco: DecorationSet.empty }),
      apply(tr: Transaction, value: DiagnosticsState) {
        const incoming = tr.getMeta(diagnosticsPluginKey) as
          | Diagnostic[]
          | undefined;
        // Record edits made while a check is outstanding, so its results
        // can be moved onto the text as it stands when they arrive.
        if (inflight && tr.docChanged) inflight.maps.push(tr.mapping);

        if (incoming) {
          const usable = withinDocument(tr.doc, incoming);
          return {
            diagnostics: usable,
            deco: diagnosticDecorations(tr.doc, usable)
          };
        }
        if (!tr.docChanged) return value;
        // No new results: carry the existing squiggles through the edit so
        // they track the text they belong to instead of flickering off and
        // back on while the user types. The diagnostics are mapped with
        // them — they are what right-click and "apply this suggestion"
        // read, so letting the two drift is how a click lands on the wrong
        // text or on nothing at all.
        return {
          // Mapping can collapse a range to nothing when its text is
          // deleted; such a diagnostic is no longer about anything.
          diagnostics: withinDocument(
            tr.doc,
            value.diagnostics.map((d) => ({
              ...d,
              from: tr.mapping.map(d.from),
              to: tr.mapping.map(d.to)
            }))
          ),
          deco: value.deco.map(tr.mapping, tr.doc)
        };
      }
    },
    view(view) {
      // Check once on open so an existing note shows its squiggles without
      // requiring an edit first.
      const initial = setTimeout(() => run(view), 0);
      // Settings and dictionary changes are invisible from inside the
      // editor, so re-check immediately rather than on the next keystroke.
      const unsubscribe = options.subscribeInvalidate?.(() => {
        if (timer !== null) clearTimeout(timer);
        controller?.abort();
        void run(view);
      });
      return {
        update(updatedView, prevState) {
          if (updatedView.state.doc.eq(prevState.doc)) return;
          // The open menu describes a document that no longer exists.
          options.onDismissMenu?.();
          // Deliberately does NOT abort an outstanding check. Cancelling on
          // every keystroke is why opening a note took so long: each edit
          // threw away a request already seconds into flight and started the
          // wait again.
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(() => run(updatedView), debounceMs);
        },
        destroy() {
          clearTimeout(initial);
          unsubscribe?.();
          cancel();
        }
      };
    },
    props: {
      decorations(state) {
        return diagnosticsPluginKey.getState(state)?.deco;
      },
      handleDOMEvents: {
        contextmenu(view, event) {
          if (!options.onRequestMenu) return false;
          const pos = view.posAtCoords({
            left: event.clientX,
            top: event.clientY
          });
          if (!pos) return false;
          const found = diagnosticsPluginKey.getState(view.state)?.diagnostics;
          const hit = found?.find((d) => d.from <= pos.pos && pos.pos <= d.to);
          if (!hit) return false;
          // Claim the event: the root layout suppresses unhandled
          // contextmenu in PROD, so without stopping propagation here the
          // popover would open and be dismissed in the same gesture.
          event.preventDefault();
          event.stopPropagation();
          options.onRequestMenu(hit, event, {
            word: view.state.doc.textBetween(hit.from, hit.to),
            apply: (replacement) => {
              // Re-validate against the document as it is NOW. The menu may
              // have been open across an edit, and dispatching a range that
              // no longer exists throws — which the click handler swallows,
              // so the suggestion appears to do nothing at all.
              const { doc } = view.state;
              if (hit.to > doc.content.size || hit.from >= hit.to) return;
              // Dispatched through the view so the collab plugin sees an
              // ordinary local edit; the checker must never touch the Yjs
              // document directly.
              view.dispatch(
                view.state.tr.insertText(replacement, hit.from, hit.to)
              );
              view.focus();
            }
          });
          return true;
        }
      }
    }
  });
}
