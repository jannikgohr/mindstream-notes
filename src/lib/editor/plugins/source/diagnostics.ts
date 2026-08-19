/**
 * Rendering text diagnostics in the raw-markdown surface.
 *
 * The mirror of `../prose/diagnostics.ts`, and deliberately built to draw
 * the SAME thing: identical CSS classes, identical popover, identical
 * suggestions. A user switching between WYSIWYG and Source must not see the
 * two panes disagree about which words are wrong.
 *
 * Where they differ is how each recovers structure. The prose plugin reads
 * the ProseMirror document, which already knows what is code. Here the
 * document is source text, so a `DiagnosticSyntax` re-derives that by parsing
 * — the same answer via the best signal each surface actually has.
 *
 * The syntax is a parameter rather than a fact, because this surface is no
 * longer only ever holding Markdown: the same extension now draws squiggles in
 * a Typst document, where `#set page(margin: 2cm)` is not prose, and in a
 * Kanban card description, where `#` is just a hash. See
 * `$lib/diagnostics/syntax`.
 *
 * Not built on `@codemirror/lint`: that comes with its own gutter markers,
 * panel and tooltip styling, which would make the source pane's squiggles
 * and menus look nothing like the WYSIWYG pane's. Plain decorations plus
 * the shared popover keep the two identical.
 */

import {
  ChangeSet,
  StateEffect,
  StateField,
  type Extension
} from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { excludeIgnored, maskRanges } from '$lib/diagnostics/ignore-ranges';
import { markdownSyntax, type DiagnosticSyntax } from '$lib/diagnostics/syntax';
import { isAbortError } from '$lib/diagnostics/bus';
import type { Diagnostic, Segment } from '$lib/diagnostics/types';
import type { DiagnosticMenuContext } from '$lib/diagnostics/popover-bridge.svelte';

/** Replaces the drawn diagnostics wholesale. */
export const setDiagnostics = StateEffect.define<Diagnostic[]>();

/**
 * Paragraph segmentation, re-exported for the callers that grew up importing
 * it from here — it is syntax-independent and now lives with the syntaxes.
 */
export { splitParagraphs } from '$lib/diagnostics/syntax';

const diagnosticMark = (kind: Diagnostic['kind']) =>
  Decoration.mark({ class: `cm-diagnostic diagnostic-${kind}` });

function buildDecorations(
  diagnostics: Diagnostic[],
  docLength: number
): DecorationSet {
  const ranges = diagnostics
    // Guard against a stale result outliving the text it described —
    // RangeSet throws on an out-of-bounds or inverted range.
    .filter((d) => d.from >= 0 && d.to <= docLength && d.from < d.to)
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .map((d) => diagnosticMark(d.kind).range(d.from, d.to));
  return Decoration.set(ranges);
}

const diagnosticsField = StateField.define<{
  diagnostics: Diagnostic[];
  deco: DecorationSet;
}>({
  create: () => ({ diagnostics: [], deco: Decoration.none }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDiagnostics)) {
        return {
          diagnostics: effect.value,
          deco: buildDecorations(effect.value, tr.newDoc.length)
        };
      }
    }
    if (!tr.docChanged) return value;
    // Map the existing squiggles through the edit rather than clearing
    // them, so they stay attached to their words while the user types
    // instead of flickering off until the next check lands.
    return {
      diagnostics: value.diagnostics.map((d) => ({
        ...d,
        from: tr.changes.mapPos(d.from),
        to: tr.changes.mapPos(d.to)
      })),
      deco: value.deco.map(tr.changes)
    };
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.deco)
});

export interface SourceDiagnosticsOptions {
  check(
    segments: Segment[],
    signal: AbortSignal,
    /** Draw partial results as each checker reports. */
    onPartial?: (diagnostics: Diagnostic[]) => void
  ): Promise<Diagnostic[]>;
  debounceMs?: number;
  /**
   * What this document's text is written in. Defaults to Markdown, which is
   * what every caller meant back when it was the only thing it could be.
   */
  syntax?: DiagnosticSyntax;
  /** See the prose plugin: read per check so the setting applies live. */
  enabled?(): boolean;
  /** Dismiss an open menu when the document moves out from under it. */
  onDismissMenu?(): void;
  /** See the prose plugin: language and dictionary changes are invisible here. */
  subscribeInvalidate?(recheck: () => void): () => void;
  /** See the prose plugin: `apply` is surface-specific, so the plugin owns it. */
  onRequestMenu?(
    diagnostic: Diagnostic,
    event: MouseEvent,
    context: DiagnosticMenuContext
  ): void;
}

const DEFAULT_DEBOUNCE_MS = 400;

export function sourceDiagnostics(
  options: SourceDiagnosticsOptions
): Extension {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const syntax = options.syntax ?? markdownSyntax;

  const runner = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null;
      controller: AbortController | null = null;

      unsubscribe: (() => void) | null = null;
      /**
       * Edits made while a check is outstanding. A network check takes
       * seconds and a note keeps changing as it loads, so results are moved
       * onto the current text rather than discarded — discarding them is
       * what made squiggles take so long to appear at all.
       */
      inflight: ChangeSet | null = null;
      /** An edit arrived mid-check; run once more when this one lands. */
      rerun = false;

      constructor(readonly view: EditorView) {
        // Check on open so an existing note shows its squiggles without
        // needing an edit first.
        this.schedule(0);
        this.unsubscribe =
          options.subscribeInvalidate?.(() => this.schedule(0)) ?? null;
      }

      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        if (this.inflight) {
          this.inflight = this.inflight.compose(update.changes);
        }
        // A suggestion's range describes the document it was offered for.
        options.onDismissMenu?.();
        this.schedule(debounceMs);
      }

      destroy() {
        if (this.timer !== null) clearTimeout(this.timer);
        this.controller?.abort();
        this.unsubscribe?.();
      }

      schedule(delay: number) {
        // Does NOT abort an outstanding check: cancelling one already
        // seconds into flight on every keystroke is what made results take
        // so long to appear at all.
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.run(), delay);
      }

      async run() {
        // Single-flight; the trailing re-run picks up anything that changed.
        if (this.inflight) {
          this.rerun = true;
          return;
        }
        if (options.enabled && !options.enabled()) {
          // Clear rather than return — the user may have just switched it off.
          const { diagnostics } = this.view.state.field(diagnosticsField);
          if (diagnostics.length > 0) {
            this.view.dispatch({ effects: setDiagnostics.of([]) });
          }
          return;
        }
        this.controller = new AbortController();
        const { signal } = this.controller;
        this.inflight = ChangeSet.empty(this.view.state.doc.length);
        const text = this.view.state.doc.toString();
        // Awaited: a plugin-declared grammar computes its patterns in a
        // Worker, so this is the one step of the check that can suspend before
        // any provider is called. `inflight` is already open, so edits made
        // while it resolves are mapped like any other.
        const ignored = await syntax.ignoreRanges(text);
        // Mask BEFORE segmenting, not just filter afterwards: a network
        // checker has already received the text by the time results come
        // back, so code blocks and link targets would leave the machine only
        // to have their findings discarded. Masking is offset-preserving, so
        // positions still line up with the real document.
        const segments = syntax.segment(maskRanges(text, ignored));

        // Filter in the coordinates the check ran against, then carry the
        // survivors onto the text as it stands now.
        const draw = (diagnostics: Diagnostic[]) => {
          if (signal.aborted) return;
          const changes = this.inflight;
          const kept = excludeIgnored(diagnostics, ignored).map((d) => ({
            ...d,
            from: changes ? changes.mapPos(d.from, 1) : d.from,
            to: changes ? changes.mapPos(d.to, -1) : d.to
          }));
          this.view.dispatch({ effects: setDiagnostics.of(kept) });
        };

        try {
          draw(await options.check(segments, signal, draw));
        } catch (err) {
          if (!isAbortError(err))
            console.error('Diagnostics check failed', err);
        } finally {
          this.inflight = null;
          if (this.rerun) {
            this.rerun = false;
            void this.run();
          }
        }
      }
    }
  );

  const contextMenu = EditorView.domEventHandlers({
    contextmenu(event, view) {
      if (!options.onRequestMenu) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const { diagnostics } = view.state.field(diagnosticsField);
      const hit = diagnostics.find((d) => d.from <= pos && pos <= d.to);
      if (!hit) return false;
      // Claim the event — the root layout suppresses unhandled contextmenu
      // in PROD, which would otherwise dismiss the popover as it opens.
      event.preventDefault();
      event.stopPropagation();
      options.onRequestMenu(hit, event, {
        word: view.state.doc.sliceString(hit.from, hit.to),
        apply: (replacement) => {
          view.dispatch({
            changes: { from: hit.from, to: hit.to, insert: replacement }
          });
          view.focus();
        }
      });
      return true;
    }
  });

  return [diagnosticsField, runner, contextMenu];
}
