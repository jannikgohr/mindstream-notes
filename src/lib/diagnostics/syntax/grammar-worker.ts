/**
 * Runs a plugin-declared grammar off the editor thread.
 *
 * Deliberately almost empty. Everything interesting is in `grammar.ts`, which
 * is a pure function of (grammar, text) and therefore runs identically here and
 * in a test. What this file contributes is the thread — the one place a runaway
 * pattern can be stopped, because `terminate()` is the only thing in JavaScript
 * that interrupts a regex mid-match.
 *
 * It must import nothing that touches the DOM, Svelte or app state; a Worker
 * has none of them. `grammar.ts` and its dependencies are plain functions, which
 * is what makes this possible.
 */

import { grammarIgnoreRanges } from './grammar';
import type { GrammarRequest, GrammarResponse } from './grammar-protocol';

self.onmessage = (event: MessageEvent<GrammarRequest>) => {
  const { id, grammar, text } = event.data;
  const post = (message: GrammarResponse) => self.postMessage(message);
  try {
    post({ id, ranges: grammarIgnoreRanges(grammar, text) });
  } catch (err) {
    // A grammar that throws is a broken grammar, not a broken document. Report
    // it so the runner can fault the plugin rather than retry forever.
    post({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
