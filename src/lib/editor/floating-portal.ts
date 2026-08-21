/**
 * A body-level host for Crepe's floating slash menu.
 *
 * By default `SlashProvider` appends its element to `view.dom.parentElement`
 * — inside the pane that scrolls the note — and positions it absolutely.
 * An absolutely positioned box still counts towards its scroll container's
 * scrollable overflow, so an open slash menu makes the note scroll several
 * hundred pixels past its last line. Crepe 7.22 added a `slashMenu.root`
 * option; pointing it at a fixed, viewport-sized layer takes the menu out
 * of the scrolling content, and the extra scroll area goes with it.
 *
 * The layer carries the `milkdown` class because every rule Crepe ships for
 * the menu — and our whole `--crepe-color-*` mapping — is scoped under it.
 *
 * Anchoring: the menu is positioned in viewport coordinates when it opens
 * and `SlashProvider` re-runs that only on editor transactions, never on
 * scroll (unlike `TooltipProvider`, which drives floating-ui's `autoUpdate`).
 * Out in the portal, a scroll would leave the menu hanging where the caret
 * used to be, so this module does what `autoUpdate` would: it offsets the
 * whole layer by however far the pane has scrolled since the menu was last
 * positioned. Delete it once SlashProvider auto-updates upstream.
 */

const PORTAL_CLASS = 'milkdown-floating-portal';

export interface FloatingPortal {
  /** Pass as `slashMenu.root`. */
  root: HTMLElement;
  destroy: () => void;
}

/** Nearest ancestor that actually scrolls, if any. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const overflowY =
      node.ownerDocument.defaultView?.getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

export function createFloatingPortal(host: HTMLElement): FloatingPortal {
  const doc = host.ownerDocument;
  const root = doc.createElement('div');
  root.className = `milkdown ${PORTAL_CLASS}`;
  doc.body.appendChild(root);

  const pane = scrollParent(host);
  // Where the pane was scrolled the last time a child got positioned.
  let anchoredAt = pane?.scrollTop ?? 0;

  const follow = () => {
    if (!pane) return;
    const drift = pane.scrollTop - anchoredAt;
    root.style.transform = drift === 0 ? '' : `translateY(${-drift}px)`;
  };

  // Crepe writes `left`/`top` when it positions the menu and flips
  // `data-show` when it opens it; either means the current caret is the
  // anchor again, so the drift starts over from here.
  const observer = new MutationObserver((records) => {
    if (!records.some((record) => record.target !== root)) return;
    anchoredAt = pane?.scrollTop ?? 0;
    root.style.transform = '';
  });
  observer.observe(root, {
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'data-show']
  });

  pane?.addEventListener('scroll', follow, { passive: true });

  return {
    root,
    destroy: () => {
      observer.disconnect();
      pane?.removeEventListener('scroll', follow);
      root.remove();
    }
  };
}
