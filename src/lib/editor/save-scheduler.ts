import { onAppSuspend } from './suspend-flush';

export const SAVE_DEBOUNCE_MS = 800;

/** One pending-save contract for debounce, suspend, and component teardown.
 * The save callback must capture its document synchronously before awaiting. */
export function createSaveScheduler(options: {
  canSave: () => boolean;
  save: () => Promise<void>;
  delayMs?: () => number;
  onError?: (error: unknown) => void;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let disposed = false;
  const active = new Set<Promise<void>>();
  function cancel() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = false;
  }
  async function flush(): Promise<void> {
    const shouldSave = pending && options.canSave();
    cancel();
    if (shouldSave) {
      // Invoke now, so teardown cannot destroy the document before capture.
      let saving: Promise<void> | undefined;
      try {
        saving = options.save();
        active.add(saving);
        await saving;
      } catch (error) {
        if (!disposed) pending = true;
        options.onError?.(error);
        throw error;
      } finally {
        if (saving) active.delete(saving);
      }
    }
    await Promise.all([...active]);
  }
  function schedule() {
    cancel();
    if (disposed || !options.canSave()) return;
    pending = true;
    timer = setTimeout(() => {
      void flush().catch(() => {});
    }, options.delayMs?.() ?? SAVE_DEBOUNCE_MS);
  }
  return {
    schedule,
    flush,
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
