/**
 * Flush-on-suspend hook for note editors.
 *
 * Every editor debounces its save (800ms). That window is safe against a
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
export function onAppSuspend(flush: () => void): () => void {
  if (typeof document === 'undefined') return () => {};

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  const onPageHide = () => flush();

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);

  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
  };
}
