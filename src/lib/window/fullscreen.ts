/**
 * Tauri window fullscreen helpers, ref-counted.
 *
 * Single use case today: freeform notes auto-fullscreen the window on
 * mobile open and restore it on close. The ref count lets multiple
 * freeform tabs coexist — only the first acquire transitions the window
 * into fullscreen and only the last release restores the prior state.
 * We stash the pre-acquire fullscreen value so we don't *force* a
 * restore if the user was already fullscreen before opening any
 * freeform note.
 *
 * Outside Tauri (a `pnpm dev` browser tab) every call is a silent no-op,
 * so consumers don't need to gate. Errors from the Tauri side are logged
 * and swallowed for the same reason — losing a fullscreen toggle to a
 * busy event loop shouldn't propagate up into the note editor.
 */

interface WindowApi {
  setFullscreen: (v: boolean) => Promise<void>;
  isFullscreen: () => Promise<boolean>;
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
      isFullscreen: () => w.isFullscreen()
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
