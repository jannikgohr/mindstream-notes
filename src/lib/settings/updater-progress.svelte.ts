/**
 * Shared $state for the updater progress dialog. Lives in its own
 * `.svelte.ts` file (not the component) for the same reason as
 * confirm-dialog: TypeScript's ambient `declare module '*.svelte'`
 * shim only exposes the default export, so named state imports off a
 * Svelte component break at IDE time even though Vite resolves them
 * at runtime.
 *
 * The pattern is "one singleton component (UpdaterProgressDialog.svelte)
 * watches this state; any caller calls beginDownload/updateProgress/
 * finishDownload/endProgress to drive it." We export those helpers
 * rather than letting callers mutate the state directly so the
 * throttle + phase transitions stay in one place.
 */

export type ProgressPhase = 'downloading' | 'installing';

interface ProgressState {
  /** Dialog is mounted + visible when true. */
  active: boolean;
  phase: ProgressPhase | null;
  /** Bytes downloaded so far. May be 0 with a non-zero total while we wait for the first chunk. */
  downloaded: number;
  /** Total bytes (Content-Length). 0 means "unknown" — render an indeterminate bar. */
  total: number;
}

export const updaterProgress = $state<ProgressState>({
  active: false,
  phase: null,
  downloaded: 0,
  total: 0
});

/**
 * Tauri's updater `Progress` events fire per HTTP chunk — hundreds of
 * times per MB. Pushing to `$state` on every event triggers a Svelte
 * effect re-run per fire, which hammers the render loop. Throttle to
 * 60 ms (~16 fps) — plenty smooth for a progress bar, and lets the
 * download itself dominate the wall clock instead of the UI.
 */
const THROTTLE_MS = 60;
let lastTick = 0;
let pendingDownloaded = 0;

/** Show the dialog at the start of download. Total may be 0 if the server didn't send Content-Length. */
export function beginDownload(total: number): void {
  pendingDownloaded = 0;
  lastTick = 0;
  updaterProgress.downloaded = 0;
  updaterProgress.total = total;
  updaterProgress.phase = 'downloading';
  updaterProgress.active = true;
}

/** Accumulate a chunk. Caller passes the chunk length, not the running total. */
export function recordChunk(chunkLength: number): void {
  pendingDownloaded += chunkLength;
  const now = performance.now();
  if (now - lastTick >= THROTTLE_MS) {
    updaterProgress.downloaded = pendingDownloaded;
    lastTick = now;
  }
}

/**
 * Flush the throttle and flip to install phase. Tauri's `Finished` event
 * means "download done, install starting", not "everything done" — the
 * install runs after this and `downloadAndInstall()` only resolves
 * once it's complete. During install the bar is indeterminate because
 * the plugin doesn't emit install-side progress.
 */
export function finishDownload(): void {
  updaterProgress.downloaded = pendingDownloaded;
  updaterProgress.phase = 'installing';
}

/** Hide the dialog. Always call this in a `finally` so a thrown install error doesn't leave the dialog stuck open. */
export function endProgress(): void {
  updaterProgress.active = false;
  updaterProgress.phase = null;
  updaterProgress.downloaded = 0;
  updaterProgress.total = 0;
  pendingDownloaded = 0;
  lastTick = 0;
}
