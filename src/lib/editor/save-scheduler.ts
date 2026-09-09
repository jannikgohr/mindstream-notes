import { onAppSuspend } from './suspend-flush';

export const SAVE_DEBOUNCE_MS = 800;

/** One pending-save contract for debounce, suspend, and component teardown.
 * Capture runs synchronously; persistence runs in capture order. */
export function createSaveScheduler(options: {
  canSave: () => boolean;
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
  async function flush(): Promise<void> {
    while (true) {
      const shouldSave = pending && options.canSave();
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
    if (disposed || !options.canSave()) return;
    pending = true;
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
    subscribeSuspend: () => onAppSuspend(flush),
    destroy() {
      // Start the final capture while the component's document still exists.
      const saving = flush();
      disposed = true;
      return saving.catch(() => {});
    }
  };
}
