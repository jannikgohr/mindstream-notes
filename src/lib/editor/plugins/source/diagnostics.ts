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
 * document is Markdown text, so `ignore-ranges` re-derives that by parsing —
 * the same answer via the best signal each surface actually has.
 *
 * Not built on `@codemirror/lint`: that comes with its own gutter markers,
 * panel and tooltip styling, which would make the source pane's squiggles
 * and menus look nothing like the WYSIWYG pane's. Plain decorations plus
 * the shared popover keep the two identical.
 */

import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import {
  excludeIgnored,
  ignoreRanges,
  maskRanges
} from '$lib/diagnostics/ignore-ranges';
import { isAbortError } from '$lib/diagnostics/bus';
import type { Diagnostic, Segment } from '$lib/diagnostics/types';
import type { DiagnosticMenuContext } from '$lib/diagnostics/popover-bridge.svelte';

/** Replaces the drawn diagnostics wholesale. */
export const setDiagnostics = StateEffect.define<Diagnostic[]>();

/**
 * Cut Markdown into paragraph-sized segments on blank lines.
 *
 * Per-paragraph rather than per-document so the bus's cache does useful
 * work: editing one paragraph re-checks one paragraph. Per-LINE would
 * segment more finely still, but it would break any checker that needs a
 * whole sentence — grammar rules, and LanguageTool in particular — since a
 * sentence wrapped across two lines would be checked as two fragments.
 */
export function splitParagraphs(text: string): Segment[] {
  const segments: Segment[] = [];
  const lines = text.split('\n');

  let offset = 0;
  let start = -1;
  let end = -1;

  const flush = () => {
    if (start === -1) return;
    segments.push({ text: text.slice(start, end), from: start, to: end });
    start = -1;
  };

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;

    if (line.trim().length === 0) {
      flush();
      continue;
    }
    if (start === -1) start = lineStart;
    end = lineStart + line.length;
  }
  flush();

  return segments;
}

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
  check(segments: Segment[], signal: AbortSignal): Promise<Diagnostic[]>;
  debounceMs?: number;
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

  const runner = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null;
      controller: AbortController | null = null;

      unsubscribe: (() => void) | null = null;

      constructor(readonly view: EditorView) {
        // Check on open so an existing note shows its squiggles without
        // needing an edit first.
        this.schedule(0);
        this.unsubscribe =
          options.subscribeInvalidate?.(() => this.schedule(0)) ?? null;
      }

      update(update: ViewUpdate) {
        if (!update.docChanged) return;
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
        if (this.timer !== null) clearTimeout(this.timer);
        this.controller?.abort();
        this.timer = setTimeout(() => void this.run(), delay);
      }

      async run() {
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
        const text = this.view.state.doc.toString();
        const ignored = ignoreRanges(text);
        // Mask BEFORE segmenting, not just filter afterwards: a network
        // checker has already received the text by the time results come
        // back, so code blocks and link targets would leave the machine only
        // to have their findings discarded. Masking is offset-preserving, so
        // positions still line up with the real document.
        const segments = splitParagraphs(maskRanges(text, ignored));

        try {
          const diagnostics = await options.check(segments, signal);
          // The text may have moved on while the check was in flight; a
          // fresh run is already queued, so drop the stale answer rather
          // than drawing it at positions that no longer mean anything.
          if (signal.aborted || this.view.state.doc.toString() !== text) return;
          this.view.dispatch({
            effects: setDiagnostics.of(excludeIgnored(diagnostics, ignored))
          });
        } catch (err) {
          if (!isAbortError(err))
            console.error('Diagnostics check failed', err);
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
