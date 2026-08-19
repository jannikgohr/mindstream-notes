/**
 * The budget and the kill switch for plugin-declared patterns.
 *
 * A plugin's regex is untrusted computation on the hot path — recomputed on
 * every keystroke, over the whole document, on the thread that draws the
 * editor. The danger is not a hostile plugin so much as an ordinary one: a
 * pattern that is instant on the author's test file and exponential on a note
 * with a long unbroken line. There is no static check that rules this out;
 * star-height analysis misses cases as plain as `(a|ab)*`, and `safe-regex` is
 * known to pass patterns that blow up.
 *
 * So the guarantee is not "the pattern is safe", it is "the pattern is
 * stoppable". It runs in a Worker with a deadline, and if it overruns, the
 * Worker is TERMINATED. Nothing gentler works: a single `String.matchAll` call
 * cannot be interrupted, so measuring afterwards would prevent the second
 * freeze and never the first.
 *
 * This is the contract scripted plugins already have — `limits.timeoutMs`,
 * `spawn_blocking`, `catch_unwind` — where a plugin fault costs the plugin
 * instead of the app. See docs/plugins.
 *
 * FAILURE IS LOUD AND STICKY. An overrun faults that grammar permanently for
 * the session: further checks fall back to its delimiters, and the plugin is
 * reported so the user can see why. Retrying would re-freeze on every
 * keystroke, and silently unchecked notes are worse than visibly broken ones.
 */

import type { TextRange } from '../types';
import type { DiagnosticGrammar } from './grammar';
import type { GrammarRequest, GrammarResponse } from './grammar-protocol';

/**
 * How long a grammar gets to describe one document.
 *
 * Generous on purpose. Checks are debounced by 400ms and this runs off-thread,
 * so a quarter second costs the user nothing, while linear-time patterns finish
 * a megabyte far inside it. Anything that exceeds this is not slow, it is
 * diverging — the failure mode being guarded against is unbounded, not merely
 * expensive, so there is no value in a tight bound.
 */
const BUDGET_MS = 250;

/** Grammars that have already broken their budget, and are not asked again. */
const faulted = new WeakSet<DiagnosticGrammar>();

interface Pending {
  resolve(ranges: TextRange[] | null): void;
  grammar: DiagnosticGrammar;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let pending = new Map<number, Pending>();
let nextId = 1;

/**
 * Whether this environment can isolate a pattern at all.
 *
 * Server-side rendering and the unit-test runner have no Worker. Patterns are
 * then simply not run — see `runGrammar`. Falling back to inline execution
 * would be the one thing this module exists to prevent, and a fallback that
 * quietly removes the safety property is worse than not having the feature.
 */
function workerAvailable(): boolean {
  return typeof Worker !== 'undefined';
}

function spawn(): Worker | null {
  if (worker) return worker;
  if (!workerAvailable()) return null;
  try {
    worker = new Worker(new URL('./grammar-worker.ts', import.meta.url), {
      type: 'module'
    });
  } catch {
    return null;
  }
  worker.onmessage = (event: MessageEvent<GrammarResponse>) => {
    const { id, ranges, error } = event.data;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (error !== undefined) faulted.add(entry.grammar);
    entry.resolve(error === undefined ? (ranges ?? null) : null);
  };
  // A crashed Worker must not leave every caller awaiting forever.
  worker.onerror = () => kill();
  return worker;
}

/**
 * Terminate the Worker and settle everything it was carrying.
 *
 * Callers get `null` — "no answer" — rather than an error, because there is
 * always a usable weaker answer available (the grammar's delimiters), and a
 * document that loses its squiggles entirely because one pattern misbehaved
 * would be a worse outcome than the pattern being ignored.
 */
function kill(): void {
  worker?.terminate();
  worker = null;
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.resolve(null);
  }
  pending = new Map();
}

/**
 * Ranges for a grammar whose patterns must be isolated.
 *
 * Resolves to `null` when the patterns could not be run — no Worker here, this
 * grammar already overran, or the Worker died. The caller falls back to the
 * delimiters, which are bounded and safe to run inline.
 */
export function runGrammar(
  grammar: DiagnosticGrammar,
  text: string
): Promise<TextRange[] | null> {
  if (faulted.has(grammar)) return Promise.resolve(null);
  const active = spawn();
  if (!active) return Promise.resolve(null);

  const id = nextId++;
  const request: GrammarRequest = { id, grammar, text };

  return new Promise<TextRange[] | null>((resolve) => {
    const timer = setTimeout(() => {
      // Sticky: this grammar is never asked again, so one bad pattern costs one
      // timeout rather than one per keystroke for the rest of the session.
      faulted.add(grammar);
      pending.delete(id);
      resolve(null);
      // Everything queued behind it dies with the thread; each of those callers
      // resolves to null and falls back too.
      kill();
    }, BUDGET_MS);

    pending.set(id, { resolve, grammar, timer });
    active.postMessage(request);
  });
}

/** True once a grammar has broken its budget or thrown. */
export function grammarFaulted(grammar: DiagnosticGrammar): boolean {
  return faulted.has(grammar);
}

/** Tear the Worker down — for tests, and for a full plugin-registry reset. */
export function resetGrammarRunner(): void {
  kill();
  nextId = 1;
}
