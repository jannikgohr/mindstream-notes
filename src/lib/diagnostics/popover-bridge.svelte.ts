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

interface OpenPopover extends DiagnosticMenuContext {
  diagnostic: Diagnostic;
  /** Viewport coordinates of the click, for positioning. */
  x: number;
  y: number;
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
