/**
 * Coalesce work that only keeps the UI current until the page is seen.
 *
 * A hidden page (closed to the tray, minimised, or backgrounded on Android)
 * gains nothing from refreshing what nobody can see, and on Windows doing it
 * anyway pulls back the memory a parked webview gave up. Requests made while
 * hidden collapse into one run on the next `visibilitychange` to visible.
 */
export function deferWhileHidden(run: () => void): {
  request: () => void;
  dispose: () => void;
} {
  if (typeof document === 'undefined') {
    return { request: run, dispose: () => {} };
  }
  let pending = false;
  const onVisibilityChange = () => {
    if (!pending || document.visibilityState !== 'visible') return;
    pending = false;
    run();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  return {
    request() {
      if (document.visibilityState === 'visible') run();
      else pending = true;
    },
    dispose() {
      pending = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };
}
