import { onAppSuspend } from './suspend-flush';

export const SAVE_DEBOUNCE_MS = 800;

/** One pending-save contract for debounce, suspend, and component teardown.
 * Capture runs synchronously; persistence runs in capture order. */
export function createSaveScheduler(options: {
  canSave: () => boolean;
  /** Explicit close can save manual edits while automatic saving is disabled. */
  canSaveOnClose?: () => boolean;
  beforeFlush?: () => void;
  capture: () => (() => Promise<void>) | null;
  delayMs?: () => number;
  onError?: (error: unknown) => void;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let disposed = false;
  let captureVersion = 0;
  let saveTail: Promise<void> = Promise.resolve();
  function cancel() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = false;
  }
  async function flush(closing = false): Promise<void> {
    options.beforeFlush?.();
    while (true) {
      const allowed = closing
        ? (options.canSaveOnClose ?? options.canSave)()
        : options.canSave();
      // Keep manual edits pending for explicit close without spinning or
      // arming an autosave timer. Read-only/trash guards still take precedence.
      if (pending && !allowed && options.canSaveOnClose?.()) {
        await saveTail;
        return;
      }
      const shouldSave = pending && allowed;
      cancel();
      if (shouldSave) {
        const version = ++captureVersion;
        let persist: (() => Promise<void>) | null;
        try {
          // Capture before the first await so teardown may release the document.
          persist = options.capture();
        } catch (error) {
          if (!disposed && version === captureVersion) pending = true;
          options.onError?.(error);
          throw error;
        }
        if (persist) {
          const saving = saveTail.catch(() => {}).then(persist);
          saveTail = saving.catch((error) => {
            if (!disposed && version === captureVersion) pending = true;
            options.onError?.(error);
            throw error;
          });
        }
      }
      const waiting = saveTail;
      await waiting;
      // A reload/suspend flush also drains edits captured while it was waiting.
      if (waiting === saveTail && !pending) return;
    }
  }
  function schedule() {
    cancel();
    if (disposed || !(options.canSave() || options.canSaveOnClose?.())) return;
    pending = true;
    if (!options.canSave()) return;
    timer = setTimeout(() => {
      void flush().catch(() => {});
    }, options.delayMs?.() ?? SAVE_DEBOUNCE_MS);
  }
  function saveNow(): Promise<void> {
    if (!disposed && options.canSave()) {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = true;
    }
    return flush();
  }
  return {
    schedule,
    flush,
    saveNow,
    cancel,
    get pending() {
      return pending;
    },
    subscribeSuspend: () =>
      onAppSuspend(
        () => flush(),
        () => flush(true)
      ),
    destroy() {
      // Start the final capture while the component's document still exists.
      const saving = flush(true);
      disposed = true;
      return saving.catch(() => {});
    }
  };
}
