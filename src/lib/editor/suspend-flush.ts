/**
 * Flush-on-suspend hook for note editors.
 *
 * Editors debounce saves through createSaveScheduler. Controlled desktop closes
 * await onAppClose callbacks before destroying any webview. These suspend hooks
 * also cover Android backgrounding and browser navigation, where component
 * teardown cannot reliably run or await saves.
 *
 * Two events, because no single one covers both platforms:
 *
 *   - `visibilitychange` → hidden fires when Android backgrounds the app,
 *     which is the only warning we get before it may be killed. It also
 *     fires on desktop when the window is minimised or occluded, so the
 *     flush must be cheap and idempotent.
 *   - `pagehide` fires on webview teardown and navigation away, including
 *     the paths where `visibilitychange` doesn't fire first.
 *
 * Both can fire for one suspend, so `flush` is called more than once per
 * cycle by design. Callers gate on their own pending-save flag.
 *
 * This is best-effort, not a guarantee. The flush kicks off an async IPC
 * call and the process may die before it lands. It converts "always lose
 * the debounce window" into "usually keep it", which is the most a
 * webview can do here.
 */
type SuspendFlush = () => void | Promise<void>;
/** Each editor's suspend flush, mapped to its close flush. */
const pendingFlushes = new Map<SuspendFlush, SuspendFlush>();
const closeFlushes = new Set<SuspendFlush>();

/** A controlled close must await every participant, even if one save fails. */
export async function flushBeforeAppClose(): Promise<void> {
  const results = await Promise.allSettled(
    [...closeFlushes].map((flush) => Promise.resolve().then(flush))
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

export function onAppClose(flush: SuspendFlush): () => void {
  closeFlushes.add(flush);
  return () => {
    closeFlushes.delete(flush);
  };
}

/**
 * Save all mounted editors before an intentional full-page reload, or before
 * anything else that would replace what they show: a restore, a move to the
 * trash, a hand-off to another window. Uses each editor's close flush, so
 * edits held back because autosave is off are saved too, as closing the
 * window would.
 */
export async function flushPendingEditorSaves(): Promise<void> {
  const flushes = [...pendingFlushes.values()].map((close) =>
    Promise.resolve().then(() => close())
  );
  await Promise.all(flushes);
}

export function onAppSuspend(flush: SuspendFlush, close = flush): () => void {
  if (typeof document === 'undefined') return () => {};
  pendingFlushes.set(flush, close);
  const stopClose = onAppClose(close);
  const run = () => {
    try {
      void Promise.resolve(flush()).catch((error) => {
        console.error('[editor] suspend save failed', error);
      });
    } catch (error) {
      console.error('[editor] suspend save failed', error);
    }
  };

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') run();
  };
  const onPageHide = run;

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);

  return () => {
    pendingFlushes.delete(flush);
    stopClose();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
  };
}
