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
import { createDiagnosticRunner } from '$lib/diagnostics/runner';
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
      unsubscribe: (() => void) | null = null;
      changes: ChangeSet | null = null;
      runner: ReturnType<typeof createDiagnosticRunner>;

      constructor(readonly view: EditorView) {
        this.runner = createDiagnosticRunner({
          debounceMs,
          enabled: options.enabled,
          clear: () => {
            if (this.view.state.field(diagnosticsField).diagnostics.length > 0)
              this.view.dispatch({ effects: setDiagnostics.of([]) });
          },
          run: async ({ signal, publish }) => {
            this.changes = ChangeSet.empty(this.view.state.doc.length);
            try {
              const text = this.view.state.doc.toString();
              const ignored = await syntax.ignoreRanges(text);
              if (signal.aborted) return;
              // Mask before segmentation so providers never receive ignored text.
              // Offsets remain aligned with the original snapshot.
              const segments = syntax.segment(maskRanges(text, ignored));
              const draw = (diagnostics: Diagnostic[]) =>
                publish(() => {
                  const kept = excludeIgnored(diagnostics, ignored).map(
                    (d) => ({
                      ...d,
                      from: this.changes!.mapPos(d.from, 1),
                      to: this.changes!.mapPos(d.to, -1)
                    })
                  );
                  this.view.dispatch({ effects: setDiagnostics.of(kept) });
                });
              draw(await options.check(segments, signal, draw));
            } finally {
              this.changes = null;
            }
          }
        });
        this.runner.start();
        this.unsubscribe =
          options.subscribeInvalidate?.(() => this.runner.invalidate()) ?? null;
      }

      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        if (this.changes) {
          this.changes = this.changes.compose(update.changes);
        }
        // A suggestion's range describes the document it was offered for.
        options.onDismissMenu?.();
        this.runner.documentChanged();
      }

      destroy() {
        this.runner.destroy();
        const unsubscribe = this.unsubscribe;
        this.unsubscribe = null;
        unsubscribe?.();
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
