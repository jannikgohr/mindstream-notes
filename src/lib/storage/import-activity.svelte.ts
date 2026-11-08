/**
 * Whether a notes import is running, in this window or another.
 *
 * An import is one transaction that holds the vault's write lock until it
 * ends: in the app on a database connection of its own, in a browser inside
 * the storage worker. A write sent meanwhile would fail with "database is
 * locked" in the app, or wait unseen behind the import in a browser, so
 * writes wait here until the import is over, and every window shows that it
 * is running (`ImportProgressOverlay`). The window that runs the import
 * reports through `import-progress` events, ending with the phase
 * `finished`; see `import-activity-bridge.ts`.
 *
 * Kept free of API imports: the invoke gate in `api/core.ts` waits on it.
 */

export const importActivity = $state<{
  running: boolean;
  /** Notes processed so far, and in all. Both 0 until the first batch. */
  done: number;
  total: number;
  /** The import dialog shows the progress itself, so the overlay stays away. */
  shownByDialog: boolean;
}>({ running: false, done: 0, total: 0, shownByDialog: false });

let waiters: Array<() => void> = [];

/** Take in one `import-progress` event. */
export function importProgressed(progress: {
  phase: string;
  done: number;
  total: number;
}): void {
  if (progress.phase === 'finished') {
    importFinished();
    return;
  }
  importActivity.running = true;
  if (progress.phase === 'importing' || progress.phase === 'done') {
    importActivity.done = progress.done;
    importActivity.total = progress.total;
  }
}

/** The import is over, however it ended. Held writes go ahead. */
export function importFinished(): void {
  importActivity.running = false;
  importActivity.done = 0;
  importActivity.total = 0;
  const settled = waiters;
  waiters = [];
  for (const resolve of settled) resolve();
}

/** Resolve once no import is running. */
export function whenNoImportRuns(): Promise<void> {
  if (!importActivity.running) return Promise.resolve();
  return new Promise((resolve) => waiters.push(resolve));
}

/** Forget any running import. Test-only. */
export function resetImportActivityForTests(): void {
  importActivity.shownByDialog = false;
  importFinished();
}
