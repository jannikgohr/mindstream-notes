/**
 * State behind the diagnostic suggestion popover.
 *
 * Mirrors the bridge pattern the wikilink and @mention menus use: the editor
 * plugins are surface-agnostic and know nothing about Svelte, so they push
 * state here and the component reads it.
 *
 * Unlike those bridges there is ONE of these for the whole app rather than
 * one per surface. The wikilink bridge is per-surface because in Split view
 * both panes are live and each needs its own set of commit handlers; this
 * popover opens from a right-click, and a right-click lands in exactly one
 * pane. The context carried with each open already points at the surface
 * that was clicked.
 */

import type { Diagnostic } from './types';

/** Everything the popover needs that only the clicked surface can supply. */
export interface DiagnosticMenuContext {
  /** The flagged text itself — the plugin reads it out of its own document. */
  word: string;
  /** Writes a replacement into the surface the click came from. */
  apply: (replacement: string) => void;
}

/**
 * Where the flagged word sits on screen, so the menu can open beside it
 * rather than on top of it.
 *
 * A rect, not the pointer position: on a touch screen the gesture that opens
 * this lands in the MIDDLE of the word, so a menu anchored at that point
 * covers the rest of the line — including the word being corrected, which is
 * the one thing the user needs to see while choosing a replacement. On
 * desktop the pointer and the word are in much the same place, so anchoring
 * to the word costs nothing there.
 */
export interface DiagnosticAnchor {
  /** Left edge of the word; the menu lines up with it. */
  left: number;
  /** Top of the word's first line — the menu flips above this when it must. */
  top: number;
  /** Bottom of the word's last line — where the menu opens by default. */
  bottom: number;
}

/**
 * The anchor for a diagnostic the user just invoked the menu on.
 *
 * Read off the rendered decoration rather than recomputed from document
 * positions: both editing surfaces tag their squiggles with the same
 * `data-diagnostic-kind` attribute, so one lookup works for ProseMirror and
 * CodeMirror alike, and a word wrapped across two lines gives the union of
 * its rects — which is what "do not cover this" means for a wrapped word.
 *
 * Falls back to the pointer when the event did not land on a decoration,
 * which keeps the menu somewhere sensible rather than at the origin.
 */
export function diagnosticAnchorFrom(event: MouseEvent): DiagnosticAnchor {
  const target = event.target;
  const el =
    target instanceof Element ? target.closest('[data-diagnostic-kind]') : null;
  const rect = el?.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    return { left: event.clientX, top: event.clientY, bottom: event.clientY };
  }
  return { left: rect.left, top: rect.top, bottom: rect.bottom };
}

interface OpenPopover extends DiagnosticMenuContext {
  diagnostic: Diagnostic;
  /** Viewport rect of the flagged word, for positioning. */
  anchor: DiagnosticAnchor;
}

let open = $state<OpenPopover | null>(null);
let suggestions = $state<string[] | null>(null);
let loading = $state(false);

/**
 * Guards against a slow lookup landing after the user has moved on.
 * Suggestions take tens of milliseconds and grow superlinearly with word
 * length, so a long word's results can easily arrive after the popover has
 * been dismissed or reopened on a different word.
 */
let requestToken = 0;

export const diagnosticPopover = {
  get current(): OpenPopover | null {
    return open;
  },
  get suggestions(): string[] | null {
    return suggestions;
  },
  get loading(): boolean {
    return loading;
  }
};

export function openDiagnosticPopover(
  next: OpenPopover,
  fetchSuggestions: (word: string) => Promise<string[]>
): void {
  open = next;
  suggestions = null;
  loading = true;

  const token = ++requestToken;

  void (async () => {
    try {
      // A provider that already supplied replacements (LanguageTool returns
      // them inline) needs no second round trip.
      const found = next.diagnostic.replacements.length
        ? next.diagnostic.replacements
        : await fetchSuggestions(next.word);
      if (token !== requestToken) return;
      suggestions = found;
    } catch (err) {
      if (token !== requestToken) return;
      console.error('[diagnostics] suggestion lookup failed', err);
      suggestions = [];
    } finally {
      if (token === requestToken) loading = false;
    }
  })();
}

export function closeDiagnosticPopover(): void {
  // Bumping the token abandons any in-flight lookup.
  requestToken += 1;
  open = null;
  suggestions = null;
  loading = false;
}
