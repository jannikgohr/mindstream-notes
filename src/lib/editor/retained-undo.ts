/**
 * Undo history that outlives the webview.
 *
 * The worker unloads a window that has been hidden for long (see
 * `webview_memory.rs`), and builds it again when it is asked for. Before it
 * goes, every open editor hands its history to Rust here; when a tab mounts
 * again, its editor takes its history back. Rust keeps it in memory only, so
 * a quit still starts with empty histories.
 *
 * A browser may discard a hidden tab without another event, and the reload
 * keeps the tab's sessionStorage. So the browser hands the histories over
 * there each time the tab hides.
 *
 * An editor's history is whatever JSON its capture returns. Keys name the
 * editor and the note, e.g. `markdown:<id>`.
 */

import {
  invokeOrFallback,
  isTauri,
  optionalString,
  assertVoid,
  TauriCommandName
} from '$lib/api/core';

const SESSION_KEY = 'mindstream:undo-history';

type Capture = () => unknown;

const editors = new Map<string, Capture>();
let retained: Promise<Map<string, unknown>> | null = null;

function retainedHistories(): Promise<Map<string, unknown>> {
  retained ??= invokeOrFallback(
    TauriCommandName.TakeUndoHistory,
    undefined,
    async () => sessionStorage.getItem(SESSION_KEY),
    (value) => optionalString(value, 'retained undo history')
  )
    .then((text) => new Map(Object.entries(text ? JSON.parse(text) : {})))
    .catch((err: unknown) => {
      console.warn('[undo] retained history unavailable', err);
      return new Map<string, unknown>();
    });
  return retained;
}

/** The history an editor handed over before its window was unloaded, once. */
export async function takeRetainedUndo<T>(key: string): Promise<T | null> {
  const histories = await retainedHistories();
  const history = histories.get(key) as T | undefined;
  histories.delete(key);
  return history ?? null;
}

/**
 * Hand this editor's history over if the window is unloaded. `capture`
 * returns null when there is nothing to keep. Returns the unregister.
 */
export function retainUndoOnUnload(key: string, capture: Capture): () => void {
  editors.set(key, capture);
  return () => {
    if (editors.get(key) === capture) editors.delete(key);
  };
}

/** Before the window is unloaded: give every editor's history to Rust. */
export async function handOverUndoHistories(): Promise<void> {
  // Tabs that never mounted since the last unload still own theirs.
  const histories = new Map(await retainedHistories());
  for (const [key, capture] of editors) {
    try {
      const history = capture();
      if (history) histories.set(key, history);
      else histories.delete(key);
    } catch (err) {
      console.warn(`[undo] could not keep ${key}`, err);
    }
  }
  await invokeOrFallback(
    TauriCommandName.RetainUndoHistory,
    { history: JSON.stringify(Object.fromEntries(histories)) },
    () => keepInSession(JSON.stringify(Object.fromEntries(histories))),
    (value) => assertVoid(value, 'retain undo history')
  );
}

function keepInSession(history: string): void {
  try {
    sessionStorage.setItem(SESSION_KEY, history);
  } catch (err) {
    // An older handoff would otherwise come back after a discard.
    sessionStorage.removeItem(SESSION_KEY);
    throw err;
  }
}

/** In the browser: hand the histories over whenever the tab hides. */
export function retainUndoWhileHidden(): () => void {
  if (isTauri()) return () => {};
  const onVisibility = () => {
    if (document.visibilityState !== 'hidden') return;
    handOverUndoHistories().catch((err: unknown) =>
      console.warn('[undo] could not keep histories for this tab', err)
    );
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => document.removeEventListener('visibilitychange', onVisibility);
}
