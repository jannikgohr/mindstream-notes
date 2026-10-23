/**
 * Keep Crepe's selection toolbar out of text-selection gestures.
 *
 * Crepe positions the toolbar with a TooltipProvider that only
 * re-evaluates `shouldShow` on ProseMirror transactions. Clicking
 * *outside* the editor produces no transaction, so the toolbar used to
 * stay floating over the text after the selection visually vanished —
 * and, sitting at z-index 10 above the content, it swallowed the next
 * click into that region, which read as "I have to click twice".
 *
 * Suppress the toolbar with a host attribute while the pointer is down
 * in ProseMirror. CSS keeps it hidden even when the provider updates
 * `data-show` during a drag. Release suppression on the next frame so
 * pointerup and its click cannot land on a newly revealed toolbar.
 * Presses starting on the toolbar keep their normal behavior.
 *
 * TODO(upstream): move gesture tracking into Crepe's ToolbarView and
 * refresh its TooltipProvider after release. See docs/upstream-fixes.md.
 */

export function installSelectionToolbarAutoHide(host: HTMLElement): () => void {
  const doc = host.ownerDocument;
  const win = doc.defaultView!;
  let pointerId: number | null = null;
  let releaseFrame: number | null = null;

  const clearGesture = () => {
    if (releaseFrame !== null) win.cancelAnimationFrame(releaseFrame);
    releaseFrame = null;
    pointerId = null;
    delete host.dataset.selectionDragging;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!host.isConnected) {
      destroy();
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (host.contains(target)) {
      if (
        event.button === 0 &&
        event.isPrimary &&
        target.closest('.ProseMirror') &&
        !target.closest('.milkdown-toolbar')
      ) {
        clearGesture();
        pointerId = event.pointerId;
        host.dataset.selectionDragging = 'true';
      }
      return;
    }
    for (const toolbar of host.querySelectorAll<HTMLElement>(
      '.milkdown-toolbar'
    )) {
      if (toolbar.dataset.show === 'true') toolbar.dataset.show = 'false';
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    if (pointerId === null || event.pointerId !== pointerId) return;
    if (releaseFrame !== null) win.cancelAnimationFrame(releaseFrame);
    releaseFrame = win.requestAnimationFrame(clearGesture);
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (event.pointerId === pointerId) clearGesture();
  };

  const destroy = () => {
    clearGesture();
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('pointerup', onPointerUp, true);
    doc.removeEventListener('pointercancel', onPointerCancel, true);
    win.removeEventListener('blur', clearGesture);
  };

  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('pointerup', onPointerUp, true);
  doc.addEventListener('pointercancel', onPointerCancel, true);
  win.addEventListener('blur', clearGesture);
  return destroy;
}
