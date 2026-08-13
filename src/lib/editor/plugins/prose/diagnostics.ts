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
import { parseNoteHref } from '../wikilink-href';
import { parseUserHref } from '../user-mention-href';

export const diagnosticsPluginKey = new PluginKey<DecorationSet>('diagnostics');

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

/** Build the decoration set drawn for a list of diagnostics. */
export function diagnosticDecorations(
  doc: ProseNode,
  diagnostics: Diagnostic[]
): DecorationSet {
  const decorations = diagnostics
    // A diagnostic whose range fell outside the document (a stale result
    // racing an edit) would make DecorationSet.create throw and take the
    // editor down with it.
    .filter((d) => d.from >= 0 && d.to <= doc.content.size && d.from < d.to)
    .map((d) =>
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
  /** Called when the user right-clicks a diagnostic, to open the popover. */
  onRequestMenu?(diagnostic: Diagnostic, event: MouseEvent): void;
}

const DEFAULT_DEBOUNCE_MS = 400;

export function diagnosticsPlugin(
  options: ProseDiagnosticsOptions
): Plugin<DecorationSet> {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let current: Diagnostic[] = [];

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
  };

  async function run(view: EditorView) {
    controller = new AbortController();
    const { signal } = controller;
    // Capture the doc the results will describe. If the user types while the
    // check is in flight, the positions we get back describe a document that
    // no longer exists — the edit already scheduled a fresh run, so the stale
    // answer is dropped rather than mapped.
    const doc = view.state.doc;
    const { segments, skips } = analyzeDocument(doc);

    try {
      const diagnostics = await options.check(segments, signal);
      if (signal.aborted || view.isDestroyed || view.state.doc !== doc) return;
      current = excludeIgnored(diagnostics, skips);
      view.dispatch(view.state.tr.setMeta(diagnosticsPluginKey, current));
    } catch (err) {
      if (!isAbortError(err)) console.error('Diagnostics check failed', err);
    }
  }

  return new Plugin<DecorationSet>({
    key: diagnosticsPluginKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr: Transaction, value: DecorationSet) {
        const incoming = tr.getMeta(diagnosticsPluginKey) as
          | Diagnostic[]
          | undefined;
        if (incoming) return diagnosticDecorations(tr.doc, incoming);
        // No new results: carry the existing squiggles through the edit so
        // they track the text they belong to instead of flickering off and
        // back on while the user types.
        return value.map(tr.mapping, tr.doc);
      }
    },
    view(view) {
      // Check once on open so an existing note shows its squiggles without
      // requiring an edit first.
      const initial = setTimeout(() => run(view), 0);
      return {
        update(updatedView, prevState) {
          if (updatedView.state.doc.eq(prevState.doc)) return;
          if (timer !== null) clearTimeout(timer);
          controller?.abort();
          timer = setTimeout(() => run(updatedView), debounceMs);
        },
        destroy() {
          clearTimeout(initial);
          cancel();
        }
      };
    },
    props: {
      decorations(state) {
        return diagnosticsPluginKey.getState(state);
      },
      handleDOMEvents: {
        contextmenu(view, event) {
          if (!options.onRequestMenu) return false;
          const pos = view.posAtCoords({
            left: event.clientX,
            top: event.clientY
          });
          if (!pos) return false;
          const hit = current.find((d) => d.from <= pos.pos && pos.pos <= d.to);
          if (!hit) return false;
          // Claim the event: the root layout suppresses unhandled
          // contextmenu in PROD, so without stopping propagation here the
          // popover would open and be dismissed in the same gesture.
          event.preventDefault();
          event.stopPropagation();
          options.onRequestMenu(hit, event);
          return true;
        }
      }
    }
  });
}
