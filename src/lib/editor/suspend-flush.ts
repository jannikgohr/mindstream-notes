/**
 * Flush-on-suspend hook for note editors.
 *
 * Editors debounce saves through createSaveScheduler. That window is safe against a
 * normal close because `onDestroy` flushes, but `onDestroy` never runs when
 * the OS takes the process down: Android kills backgrounded apps outright,
 * and a webview teardown doesn't unmount Svelte components first. Without
 * this the last edit inside the debounce window is simply lost.
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
const pendingFlushes = new Set<SuspendFlush>();

/** Save all mounted editors before an intentional full-page reload. */
export async function flushPendingEditorSaves(): Promise<void> {
  const flushes = [...pendingFlushes].map((flush) =>
    Promise.resolve().then(() => flush())
  );
  await Promise.all(flushes);
}

export function onAppSuspend(flush: SuspendFlush): () => void {
  if (typeof document === 'undefined') return () => {};
  pendingFlushes.add(flush);
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
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
  };
}
