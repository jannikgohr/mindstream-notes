/**
 * Auto-hide for Crepe's selection toolbar when focus leaves the editor.
 *
 * Crepe positions the toolbar with a TooltipProvider that only
 * re-evaluates `shouldShow` on ProseMirror transactions. Clicking
 * *outside* the editor produces no transaction, so the toolbar used to
 * stay floating over the text after the selection visually vanished —
 * and, sitting at z-index 10 above the content, it swallowed the next
 * click into that region, which read as "I have to click twice".
 *
 * This helper watches pointerdown in the capture phase: any press
 * outside the editor host hides the toolbar via the same `data-show`
 * attribute the provider itself toggles (its own `hide()` early-returns
 * on `data-show='false'`, so the states can't fight). Presses inside
 * the host — including on the toolbar itself — are left alone; those
 * either operate the toolbar or dispatch a selection change that lets
 * the provider re-evaluate normally.
 */

export function installSelectionToolbarAutoHide(host: HTMLElement): void {
  const doc = host.ownerDocument;
  const onPointerDown = (event: Event) => {
    // Self-clean once the editor unmounts — buildCrepe callers don't
    // have to thread a teardown handle for this.
    if (!host.isConnected) {
      doc.removeEventListener('pointerdown', onPointerDown, true);
      return;
    }
    const target = event.target;
    if (!(target instanceof Node) || host.contains(target)) return;
    for (const toolbar of host.querySelectorAll<HTMLElement>(
      '.milkdown-toolbar'
    )) {
      if (toolbar.dataset.show === 'true') toolbar.dataset.show = 'false';
    }
  };
  doc.addEventListener('pointerdown', onPointerDown, true);
}
