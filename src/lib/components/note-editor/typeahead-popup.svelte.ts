/**
 * Lifecycle shared by the editor's typeahead menus (wikilink and user
 * mention). Call `useTypeaheadPopup` from a component's `<script>` during
 * init. Its effects belong to that component and are torn down with it.
 */

import { tick } from 'svelte';
import {
  computePosition,
  flip,
  offset,
  shift,
  size,
  type VirtualElement
} from '@floating-ui/dom';
import type {
  CaretRect,
  TypeaheadState
} from '$lib/editor/plugins/prose/typeahead';

const MENU_OFFSET = 6;
const MENU_MAX_HEIGHT = 360;
const VIEWPORT_PADDING = 8;

export interface TypeaheadBridge {
  state: TypeaheadState;
  setCommitFromPopup(commit: () => void): void;
}

/** Moves the menu to `document.body`, out from under dockview's transforms. */
export function portalToBody(node: HTMLElement) {
  document.body.appendChild(node);
  return {
    destroy() {
      node.remove();
    }
  };
}

export function useTypeaheadPopup(
  getBridge: () => TypeaheadBridge,
  candidateCount: () => number,
  commit: () => void
) {
  const bridge = $derived(getBridge());
  const popup = $state({
    el: null as HTMLDivElement | null,
    list: null as HTMLDivElement | null,
    positioned: false
  });
  let positionRun = 0;

  /**
   * Places the menu below the caret, hidden until the latest run lands. An
   * older run still writes its coordinates, but it can't reveal the menu.
   */
  async function place(rect: CaretRect, el: HTMLElement) {
    const run = ++positionRun;
    popup.positioned = false;
    const virtualEl: VirtualElement = {
      getBoundingClientRect: () => ({
        ...rect,
        x: rect.left,
        y: rect.top,
        toJSON: () => rect
      })
    };
    const { x, y } = await computePosition(virtualEl, el, {
      placement: 'bottom-start',
      middleware: [
        offset(MENU_OFFSET),
        flip({ padding: VIEWPORT_PADDING }),
        shift({ padding: VIEWPORT_PADDING }),
        size({
          padding: VIEWPORT_PADDING,
          apply({ availableHeight, elements }) {
            Object.assign(elements.floating.style, {
              maxHeight: `${Math.min(availableHeight, MENU_MAX_HEIGHT)}px`
            });
          }
        })
      ]
    });
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    if (run === positionRun && bridge.state.open) popup.positioned = true;
  }

  // Keep the highlight in range as the candidate list shrinks or grows.
  $effect(() => {
    const len = candidateCount();
    if (len === 0) {
      if (bridge.state.highlight !== 0) bridge.state.highlight = 0;
      return;
    }
    if (bridge.state.highlight >= len) {
      bridge.state.highlight = len - 1;
    } else if (bridge.state.highlight < 0) {
      bridge.state.highlight = 0;
    }
  });

  $effect(() => {
    bridge.setCommitFromPopup(commit);
  });

  $effect(() => {
    const open = bridge.state.open;
    const rect = bridge.state.caretRect;
    // Re-run on query change because the caret moves as the user types.
    void bridge.state.query;
    if (open && rect && popup.el) {
      void place(rect, popup.el);
    } else {
      positionRun += 1;
      popup.positioned = false;
    }
  });

  // The stored caret rect is viewport-relative, so a resize makes it stale.
  $effect(() => {
    if (!bridge.state.open) return;
    const onResize = () => {
      const rect = bridge.state.caretRect;
      if (rect && popup.el) void place(rect, popup.el);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  // Scroll the highlighted row into view on arrow-key navigation.
  $effect(() => {
    const idx = bridge.state.highlight;
    if (!bridge.state.open) return;
    void tick().then(() => {
      const el = popup.list?.children[idx] as HTMLElement | undefined;
      el?.scrollIntoView({ block: 'nearest' });
    });
  });

  return popup;
}
