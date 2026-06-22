/**
 * `use:tooltip` — a reliable replacement for the native `title` attribute.
 *
 * The native tooltip is flaky: it never appears on keyboard focus, has
 * inconsistent show timing, and frequently refuses to re-appear after the
 * element re-renders or is clicked (which is exactly what toggle buttons
 * do). This action instead manages its own floating label:
 *
 *   - shows on hover after a short delay, and immediately on *keyboard*
 *     focus (`:focus-visible`) — never on a mouse click's focus, so
 *     clicking a button doesn't leave a tooltip stuck open;
 *   - positions with `@floating-ui/dom` (the same lib the wikilink menu
 *     uses), so it survives CSS-transformed ancestors like dockview panels;
 *   - hides on pointer-leave, blur, Escape, or pointer-down.
 *
 * The label element is appended to `document.body` so it's never clipped by
 * an `overflow:hidden` / scroll container. Styling lives in `app.css`
 * (`.ms-tooltip`).
 */

import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  type Placement
} from '@floating-ui/dom';

export interface TooltipOptions {
  label: string;
  /** Preferred side; floating-ui flips it if there's no room. */
  side?: Placement;
}

export type TooltipParam = string | TooltipOptions | null | undefined;

const SHOW_DELAY_MS = 350;
let nextTooltipId = 1;

function normalize(param: TooltipParam): TooltipOptions {
  if (!param) return { label: '' };
  return typeof param === 'string' ? { label: param } : param;
}

export function tooltip(node: HTMLElement, param: TooltipParam) {
  let options = normalize(param);
  let tipEl: HTMLDivElement | null = null;
  let stopAutoUpdate: (() => void) | null = null;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  const tooltipId = `ms-tooltip-${nextTooltipId++}`;

  function clearTimer() {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
  }

  function show() {
    clearTimer();
    if (tipEl || !options.label || node.matches(':disabled')) return;
    const el = document.createElement('div');
    el.className = 'ms-tooltip';
    el.id = tooltipId;
    el.setAttribute('role', 'tooltip');
    el.textContent = options.label;
    document.body.appendChild(el);
    tipEl = el;
    node.setAttribute(
      'aria-describedby',
      [node.getAttribute('aria-describedby'), tooltipId]
        .filter(Boolean)
        .join(' ')
    );

    // autoUpdate keeps the label anchored as the page scrolls / resizes
    // while it's open.
    stopAutoUpdate = autoUpdate(node, el, () => {
      void computePosition(node, el, {
        strategy: 'fixed',
        placement: options.side ?? 'bottom',
        middleware: [offset(6), flip(), shift({ padding: 6 })]
      }).then(({ x, y }) => {
        if (tipEl !== el) return;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
      });
    });

    requestAnimationFrame(() => el?.classList.add('ms-tooltip-visible'));
  }

  function hide() {
    clearTimer();
    stopAutoUpdate?.();
    stopAutoUpdate = null;
    tipEl?.remove();
    tipEl = null;
    const describedBy = node
      .getAttribute('aria-describedby')
      ?.split(/\s+/)
      .filter((id) => id && id !== tooltipId)
      .join(' ');
    if (describedBy) node.setAttribute('aria-describedby', describedBy);
    else node.removeAttribute('aria-describedby');
  }

  function scheduleShow() {
    if (tipEl || showTimer || !options.label) return;
    showTimer = setTimeout(show, SHOW_DELAY_MS);
  }

  function onPointerEnter() {
    scheduleShow();
  }
  function onPointerLeave() {
    hide();
  }
  function onPointerDown() {
    // A click should dismiss any open/pending tooltip and not re-open it
    // via the focus that follows (see onFocus's focus-visible guard).
    hide();
  }
  function onFocus() {
    // Only keyboard focus shows the tooltip; mouse-click focus is not
    // focus-visible, so clicking never strands a tooltip on screen.
    if (node.matches(':focus-visible')) show();
  }
  function onBlur() {
    hide();
  }
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') hide();
  }

  node.addEventListener('pointerenter', onPointerEnter);
  node.addEventListener('pointerleave', onPointerLeave);
  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('focus', onFocus);
  node.addEventListener('blur', onBlur);
  node.addEventListener('keydown', onKeyDown);

  return {
    update(next: TooltipParam) {
      options = normalize(next);
      if (!options.label) {
        hide();
      } else if (tipEl) {
        tipEl.textContent = options.label;
      }
    },
    destroy() {
      hide();
      node.removeEventListener('pointerenter', onPointerEnter);
      node.removeEventListener('pointerleave', onPointerLeave);
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('focus', onFocus);
      node.removeEventListener('blur', onBlur);
      node.removeEventListener('keydown', onKeyDown);
    }
  };
}
