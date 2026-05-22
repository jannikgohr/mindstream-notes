/**
 * Tauri window fullscreen helpers, ref-counted.
 *
 * Two distinct call patterns live behind the same `getCurrentWindow()`:
 *
 *   - **Acquire / release** (used by mobile auto-fullscreen when a
 *     freeform note opens). The ref count lets multiple freeform tabs
 *     coexist — only the first acquire transitions the window into
 *     fullscreen and only the last release restores the prior state. We
 *     stash the pre-acquire fullscreen value so we don't *force* a
 *     restore if the user was already fullscreen before opening any
 *     freeform note.
 *
 *   - **Toggle** (used by the desktop button). Pure passthrough — flips
 *     the window's fullscreen and returns the new value. Doesn't touch
 *     the ref count, so a manual toggle while a mobile-acquired session
 *     is open won't desync the counter; the next release just reads the
 *     current state at that point.
 *
 * Outside Tauri (a `pnpm dev` browser tab) every call is a silent no-op,
 * so consumers don't need to gate. Errors from the Tauri side are logged
 * and swallowed for the same reason — losing a fullscreen toggle to a
 * busy event loop shouldn't propagate up into the note editor.
 */

interface WindowApi {
  setFullscreen: (v: boolean) => Promise<void>;
  isFullscreen: () => Promise<boolean>;
  onResized: (cb: () => void) => Promise<() => void>;
}

let cachedApi: WindowApi | null = null;
let apiProbed = false;

async function ensureApi(): Promise<WindowApi | null> {
  if (apiProbed) return cachedApi;
  apiProbed = true;
  if (typeof window === 'undefined') return null;
  if (!('__TAURI_INTERNALS__' in window)) return null;
  try {
    const mod = await import('@tauri-apps/api/window');
    const w = mod.getCurrentWindow();
    cachedApi = {
      setFullscreen: (v) => w.setFullscreen(v),
      isFullscreen: () => w.isFullscreen(),
      onResized: async (cb) => {
        const unlisten = await w.onResized(() => cb());
        return unlisten;
      }
    };
    return cachedApi;
  } catch (err) {
    console.warn('[fullscreen] Tauri window API unavailable', err);
    return null;
  }
}

let refCount = 0;
let priorState: boolean | null = null;

/**
 * Push the window into fullscreen. The first call captures the prior
 * state and flips the window; subsequent calls just bump the counter.
 */
export async function acquireFullscreen(): Promise<void> {
  const api = await ensureApi();
  if (!api) return;
  if (refCount === 0) {
    try {
      priorState = await api.isFullscreen();
      if (!priorState) await api.setFullscreen(true);
    } catch (err) {
      console.warn('[fullscreen] acquire failed', err);
    }
  }
  refCount++;
}

/**
 * Release one acquire. When the last acquirer releases, restore the
 * window to whatever fullscreen state it had before the first acquire.
 * Idempotent below zero (defensive against double-release in dev-mode
 * effect re-runs).
 */
export async function releaseFullscreen(): Promise<void> {
  if (refCount === 0) return;
  refCount--;
  if (refCount > 0) return;
  const api = await ensureApi();
  if (!api) return;
  try {
    if (priorState === false) await api.setFullscreen(false);
  } catch (err) {
    console.warn('[fullscreen] release failed', err);
  } finally {
    priorState = null;
  }
}

/** Flip the window's fullscreen flag. Returns the new state, or null
 *  outside Tauri so the caller can hide the affordance. */
export async function toggleFullscreen(): Promise<boolean | null> {
  const api = await ensureApi();
  if (!api) return null;
  try {
    const current = await api.isFullscreen();
    const next = !current;
    await api.setFullscreen(next);
    return next;
  } catch (err) {
    console.warn('[fullscreen] toggle failed', err);
    return null;
  }
}

/** Read the current fullscreen state. Returns false (not null) when the
 *  Tauri API is unreachable so consumers can use this in a boolean. */
export async function readFullscreen(): Promise<boolean> {
  const api = await ensureApi();
  if (!api) return false;
  try {
    return await api.isFullscreen();
  } catch {
    return false;
  }
}

/** Subscribe to window resize events (fullscreen transitions fire one).
 *  Returns a teardown function, or `null` outside Tauri. */
export async function onWindowResized(
  cb: () => void
): Promise<(() => void) | null> {
  const api = await ensureApi();
  if (!api) return null;
  try {
    return await api.onResized(cb);
  } catch (err) {
    console.warn('[fullscreen] onResized failed', err);
    return null;
  }
}
