import type {
  CardID,
  ColumnID,
  ColumnView,
  KanbanCard
} from '@svar-ui/kanban-store';
import { getID } from '@svar-ui/lib-dom';

import type { KanbanContextApi } from '../types.js';
import type { CardDragEdgeDirection, CardDragEdgeHandler } from '../types.js';
import type { DndState } from '../components/useDrag.svelte.js';

export type CardDragParams = {
  dnd: DndState | undefined;
  store: KanbanContextApi;
  readonly?: boolean;
  onEdgeSwitch?: CardDragEdgeHandler;
};

type Resolved = {
  dnd: DndState;
  store: KanbanContextApi;
  id: CardID;
  column: ColumnID;
  cardEl: HTMLElement;
};

const DRAG_THRESHOLD_PX = 4;
const CARD_HOLD_MS = 280;
const CARD_HOLD_MOVE_TOLERANCE_PX = 8;
export const CARD_DRAG_EDGE_ZONE_PX = 32;
export const CARD_DRAG_EDGE_MIN_TRAVEL_PX = 20;
const CARD_DRAG_EDGE_DWELL_MS = 650;
export const CARD_SCROLL_MOMENTUM_TIME_CONSTANT_MS = 325;
const CARD_SCROLL_MIN_VELOCITY_PX_PER_MS = 0.02;
export const CARD_SCROLL_MAX_VELOCITY_PX_PER_MS = 8;
export const CARD_SCROLL_VELOCITY_WINDOW_MS = 100;
export const CARD_SCROLL_RELEASE_IDLE_MS = 60;
export const CARD_DRAG_SCROLL_ZONE_PX = 48;
export const CARD_DRAG_SCROLL_MAX_SPEED_PX_PER_MS = 1.2;

export interface ScrollMomentumStep {
  delta: number;
  velocity: number;
}

export interface ScrollSample {
  time: number;
  top: number;
}

/**
 * Advance an exponentially decaying scroll animation, the curve native
 * flings follow: a flick at velocity v coasts v * timeConstant px in total.
 */
export function scrollMomentumStep(
  velocity: number,
  elapsedMs: number,
  timeConstant = CARD_SCROLL_MOMENTUM_TIME_CONSTANT_MS
): ScrollMomentumStep {
  const elapsed = Math.max(0, elapsedMs);
  const decay = Math.exp(-elapsed / timeConstant);
  return {
    delta: velocity * timeConstant * (1 - decay),
    velocity: velocity * decay
  };
}

/**
 * Release velocity of a flick, averaged over the trailing sample window.
 * Fingers slow down right before lifting, so the last move event alone
 * undersells the flick. A finger held still before lifting gets no fling.
 */
export function scrollReleaseVelocity(
  samples: readonly ScrollSample[],
  releaseTime: number,
  windowMs = CARD_SCROLL_VELOCITY_WINDOW_MS,
  idleMs = CARD_SCROLL_RELEASE_IDLE_MS
): number {
  const last = samples[samples.length - 1];
  if (!last || releaseTime - last.time > idleMs) return 0;
  const first =
    samples.find((sample) => last.time - sample.time <= windowMs) ?? last;
  const elapsed = last.time - first.time;
  if (elapsed <= 0) return 0;
  const velocity = (last.top - first.top) / elapsed;
  return Math.max(
    -CARD_SCROLL_MAX_VELOCITY_PX_PER_MS,
    Math.min(CARD_SCROLL_MAX_VELOCITY_PX_PER_MS, velocity)
  );
}

/**
 * Signed auto-scroll speed in px/ms while a dragged card sits near a scroll
 * container's edge: it ramps up the closer the pointer gets, so hovering near
 * the edge nudges and pushing into it races. Mirrors `edgeScrollSpeed` in the
 * app's src/lib/edge-auto-scroll.ts, which this package can't import.
 */
export function cardDragScrollSpeed(
  position: number,
  start: number,
  end: number,
  zone = CARD_DRAG_SCROLL_ZONE_PX,
  maxSpeed = CARD_DRAG_SCROLL_MAX_SPEED_PX_PER_MS
): number {
  const band = Math.min(zone, (end - start) / 3);
  if (band <= 0) return 0;
  const ramp = (distance: number) => {
    const depth = 1 - Math.max(0, distance) / band;
    return maxSpeed * depth * depth;
  };
  if (position - start < band) return -ramp(position - start);
  if (end - position < band) return ramp(end - position);
  return 0;
}

export function cardDragEdgeDirection(
  x: number,
  left: number,
  right: number,
  zone = CARD_DRAG_EDGE_ZONE_PX
): CardDragEdgeDirection | null {
  if (x <= left + zone) return 'previous';
  if (x >= right - zone) return 'next';
  return null;
}

export function cardDragEdgeSwitchDirection(
  x: number,
  startX: number,
  left: number,
  right: number,
  zone = CARD_DRAG_EDGE_ZONE_PX,
  minTravel = CARD_DRAG_EDGE_MIN_TRAVEL_PX
): CardDragEdgeDirection | null {
  const direction = cardDragEdgeDirection(x, left, right, zone);
  if (direction === 'previous' && startX - x >= minTravel) return direction;
  if (direction === 'next' && x - startX >= minTravel) return direction;
  return null;
}

export function cardDrag(node: HTMLElement, initial: CardDragParams) {
  let params = initial;
  let startX = 0;
  let startY = 0;
  let pending = false;
  let started = false;
  let activePointerId: number | null = null;
  let cardHoldTimer: ReturnType<typeof setTimeout> | null = null;
  let active: Resolved | null = null;
  let scrollEl: HTMLElement | null = null;
  let scrollStartTop = 0;
  let manualScrolling = false;
  let scrollSamples: ScrollSample[] = [];
  let scrollMomentumFrame = 0;
  let dragScrollColumn: HTMLElement | null = null;
  let dragScrollFrame = 0;
  let dragScrollTime = 0;
  let dragScrollRemainder = { x: 0, y: 0 };
  let edgeTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingEdge: CardDragEdgeDirection | null = null;
  let edgeLatched = false;
  let latchedEdgeColumn: ColumnID | null = null;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || params.readonly || !params.dnd || !params.store)
      return;

    cancelScrollMomentum();
    const target = e.target as HTMLElement | null;
    const cardEl = target
      ? (target.closest('[data-kanban-card-id]') as HTMLElement | null)
      : null;
    if (!cardEl || !node.contains(cardEl)) return;
    const dragHandle = cardEl.querySelector('[data-kanban-card-drag-handle]');
    const startedOnHandle = Boolean(
      target?.closest('[data-kanban-card-drag-handle]')
    );
    const fullCardDrag = Boolean(params.onEdgeSwitch);
    if (dragHandle && !startedOnHandle && !fullCardDrag) return;
    if (
      fullCardDrag &&
      !startedOnHandle &&
      target?.closest(
        'button, a, input, textarea, select, [contenteditable="true"], [data-kanban-no-drag]'
      )
    )
      return;

    const columnEl = cardEl.closest(
      '[data-kanban-column-cards]'
    ) as HTMLElement | null;
    if (!columnEl) return;

    const id = getID(cardEl, 'data-kanban-card-id') as CardID | null;
    const columnId = getID(
      columnEl,
      'data-kanban-column-cards'
    ) as ColumnID | null;
    if (id == null || columnId == null) return;

    const { viewData } = params.store.getState();
    const column = viewData.columns.find((c: ColumnView) => c.id === columnId);
    const cardRec = column?.cards.find((c: KanbanCard) => c.id === id);
    if (!column || !cardRec || cardRec.id == null) return;

    active = {
      dnd: params.dnd,
      store: params.store,
      id: cardRec.id,
      column: column.id,
      cardEl
    };

    pending = true;
    started = false;
    activePointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    scrollEl = fullCardDrag ? columnEl : null;
    scrollStartTop = columnEl.scrollTop;
    manualScrolling = false;
    scrollSamples = [{ time: e.timeStamp, top: scrollStartTop }];
    if (fullCardDrag && !startedOnHandle) {
      cardHoldTimer = setTimeout(() => {
        cardHoldTimer = null;
        if (!pending || started || !active) return;
        try {
          node.setPointerCapture(e.pointerId);
        } catch {
          // Synthetic pointer events and interrupted pointers may not be capturable.
        }
        beginDrag(e.clientX, e.clientY, active);
      }, CARD_HOLD_MS);
    }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown);
  }

  function onPointerMove(e: PointerEvent) {
    if (!pending || !active) return;
    if (params.readonly) {
      cancelActiveDrag();
      return;
    }

    if (!started) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (manualScrolling) {
        e.preventDefault();
        updateManualScroll(e, dy);
        return;
      }
      if (cardHoldTimer) {
        if (
          dx * dx + dy * dy >=
          CARD_HOLD_MOVE_TOLERANCE_PX * CARD_HOLD_MOVE_TOLERANCE_PX
        ) {
          clearTimeout(cardHoldTimer);
          cardHoldTimer = null;
          manualScrolling = true;
          e.preventDefault();
          updateManualScroll(e, dy);
        }
        return;
      }
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      beginDrag(e.clientX, e.clientY, active);
    }
    e.preventDefault();
    active.dnd.pointer = { x: e.clientX, y: e.clientY };
    const column = updateTarget(e.clientX, e.clientY, active);
    if (column) dragScrollColumn = column;
    updateEdgeSwitch(e.clientX, active);
    scheduleDragScroll();
  }

  function scheduleDragScroll() {
    if (dragScrollFrame) return;
    dragScrollTime = performance.now();
    dragScrollRemainder = { x: 0, y: 0 };
    dragScrollFrame = requestAnimationFrame(dragScrollTick);
  }

  /** Scroll the column under a dragged card, and on desktop the board, while
   *  the pointer rests near their edges. */
  function dragScrollTick(now: number) {
    dragScrollFrame = 0;
    if (!started || !active) return;
    const { x, y } = active.dnd.pointer;
    const elapsed = Math.min(32, Math.max(0, now - dragScrollTime));
    dragScrollTime = now;

    let moving = false;
    let scrolled = false;
    if (dragScrollColumn?.isConnected) {
      const rect = dragScrollColumn.getBoundingClientRect();
      const speed =
        x >= rect.left && x <= rect.right
          ? cardDragScrollSpeed(y, rect.top, rect.bottom)
          : 0;
      moving ||= speed !== 0;
      scrolled = scrollByRemainder(dragScrollColumn, 'y', speed * elapsed);
    }
    // On mobile, horizontal edges switch lists instead (updateEdgeSwitch).
    const board = params.onEdgeSwitch
      ? null
      : node.querySelector<HTMLElement>('.wx-scroll');
    if (board) {
      const rect = board.getBoundingClientRect();
      const speed = cardDragScrollSpeed(x, rect.left, rect.right);
      moving ||= speed !== 0;
      scrolled = scrollByRemainder(board, 'x', speed * elapsed) || scrolled;
    }
    if (scrolled) {
      const column = updateTarget(x, y, active);
      if (column) dragScrollColumn = column;
      updateEdgeSwitch(x, active);
    }
    if (moving) dragScrollFrame = requestAnimationFrame(dragScrollTick);
  }

  /** scrollTop/scrollLeft snap to device pixels, so slow speeds accumulate
   *  until they add up to a whole pixel. Returns whether anything moved. */
  function scrollByRemainder(
    element: HTMLElement,
    axis: 'x' | 'y',
    delta: number
  ): boolean {
    dragScrollRemainder[axis] += delta;
    const step = Math.trunc(dragScrollRemainder[axis]);
    if (step === 0) return false;
    dragScrollRemainder[axis] -= step;
    const before = axis === 'y' ? element.scrollTop : element.scrollLeft;
    if (axis === 'y') element.scrollTop += step;
    else element.scrollLeft += step;
    return (axis === 'y' ? element.scrollTop : element.scrollLeft) !== before;
  }

  function cancelDragScroll() {
    if (dragScrollFrame) cancelAnimationFrame(dragScrollFrame);
    dragScrollFrame = 0;
    dragScrollColumn = null;
  }

  function onPointerUp(e: PointerEvent) {
    const wasManualScrolling = manualScrolling;
    const momentumElement = wasManualScrolling ? scrollEl : null;
    const releaseVelocity = wasManualScrolling
      ? scrollReleaseVelocity(scrollSamples, e.timeStamp)
      : 0;
    teardownListeners();
    if (started && active) {
      commitDrop(active);
      active.dnd.reset();
      document.body.style.userSelect = '';
      suppressNextClick();
    } else if (wasManualScrolling) {
      suppressNextClick();
      if (momentumElement) {
        startScrollMomentum(momentumElement, releaseVelocity);
      }
    }
    pending = false;
    started = false;
    active = null;
  }

  function onPointerCancel() {
    cancelActiveDrag();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !started || !active) return;
    cancelActiveDrag();
  }

  function beginDrag(clientX: number, clientY: number, a: Resolved) {
    const rect = a.cardEl.getBoundingClientRect();
    a.dnd.width = rect.width;
    a.dnd.height = rect.height;
    a.dnd.offset = { x: startX - rect.left, y: startY - rect.top };
    a.dnd.pointer = { x: clientX, y: clientY };
    a.dnd.cardId = a.id;
    a.dnd.sourceColumn = a.column;
    a.dnd.target = {
      column: a.column,
      beforeId: originalBeforeId(a)
    };
    a.dnd.active = true;
    document.body.style.userSelect = 'none';
    started = true;
  }

  function updateManualScroll(event: PointerEvent, dy: number) {
    if (!scrollEl) return;
    // Sample the finger, not the clamped scrollTop, so a flick that starts
    // against an edge still measures its real speed.
    const top = scrollStartTop - dy;
    scrollEl.scrollTop = top;
    scrollSamples.push({ time: event.timeStamp, top });
    const cutoff = event.timeStamp - CARD_SCROLL_VELOCITY_WINDOW_MS;
    while (scrollSamples.length > 2 && scrollSamples[1].time <= cutoff) {
      scrollSamples.shift();
    }
  }

  function startScrollMomentum(element: HTMLElement, initialVelocity: number) {
    cancelScrollMomentum();
    if (Math.abs(initialVelocity) < CARD_SCROLL_MIN_VELOCITY_PX_PER_MS) return;

    let velocity = initialVelocity;
    // Track the position as a float: scrollTop snaps to device pixels, so
    // adding sub-pixel deltas to it would stall the slow tail of the fling.
    let position = element.scrollTop;
    let lastTime = performance.now();
    const animate = (now: number) => {
      const elapsed = Math.min(32, Math.max(0, now - lastTime));
      lastTime = now;
      const step = scrollMomentumStep(velocity, elapsed);
      position += step.delta;
      velocity = step.velocity;
      element.scrollTop = position;
      const hitEdge = Math.abs(element.scrollTop - position) > 1;
      if (Math.abs(velocity) < CARD_SCROLL_MIN_VELOCITY_PX_PER_MS || hitEdge) {
        scrollMomentumFrame = 0;
        return;
      }
      scrollMomentumFrame = requestAnimationFrame(animate);
    };
    scrollMomentumFrame = requestAnimationFrame(animate);
  }

  function cancelScrollMomentum() {
    if (scrollMomentumFrame) cancelAnimationFrame(scrollMomentumFrame);
    scrollMomentumFrame = 0;
  }

  function teardownListeners() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onKeyDown);
    if (cardHoldTimer) clearTimeout(cardHoldTimer);
    cardHoldTimer = null;
    if (activePointerId != null && node.hasPointerCapture(activePointerId)) {
      node.releasePointerCapture(activePointerId);
    }
    activePointerId = null;
    scrollEl = null;
    manualScrolling = false;
    cancelDragScroll();
    clearEdgeTimer();
    edgeLatched = false;
    latchedEdgeColumn = null;
  }

  function clearEdgeTimer() {
    if (edgeTimer) clearTimeout(edgeTimer);
    edgeTimer = null;
    pendingEdge = null;
  }

  function updateEdgeSwitch(x: number, a: Resolved) {
    if (!params.onEdgeSwitch) return;
    const rect = node.getBoundingClientRect();
    const direction = cardDragEdgeSwitchDirection(
      x,
      startX,
      rect.left,
      rect.right
    );
    if (!direction) {
      clearEdgeTimer();
      edgeLatched = false;
      latchedEdgeColumn = null;
      return;
    }

    if (edgeLatched) {
      if (
        latchedEdgeColumn != null &&
        a.dnd.target?.column !== latchedEdgeColumn
      ) {
        a.dnd.target = { column: latchedEdgeColumn, beforeId: null };
      }
      return;
    }
    if (pendingEdge === direction) return;

    clearEdgeTimer();
    pendingEdge = direction;
    edgeTimer = setTimeout(() => {
      edgeTimer = null;
      pendingEdge = null;
      if (!started || active !== a) return;
      const column = params.onEdgeSwitch?.(direction) ?? null;
      edgeLatched = true;
      if (column == null) return;
      latchedEdgeColumn = column;
      a.dnd.target = { column, beforeId: null };
    }, CARD_DRAG_EDGE_DWELL_MS);
  }

  function cancelActiveDrag() {
    teardownListeners();
    if (started && active) {
      active.dnd.reset();
      document.body.style.userSelect = '';
    }
    pending = false;
    started = false;
    active = null;
  }

  node.addEventListener('pointerdown', onPointerDown);

  return {
    update(next: CardDragParams) {
      params = next;
      if (params.readonly && (pending || started)) cancelActiveDrag();
    },
    destroy() {
      node.removeEventListener('pointerdown', onPointerDown);
      cancelScrollMomentum();
      cancelActiveDrag();
    }
  };
}

/** Point the drop target at the card slot under the pointer. Returns the
 *  column's card list when the pointer is over one. */
function updateTarget(x: number, y: number, a: Resolved): HTMLElement | null {
  const el = document.elementFromPoint(x, y);
  const columnEl = el
    ? (el.closest('[data-kanban-column-cards]') as HTMLElement | null)
    : null;

  if (!columnEl) {
    // keep the last known target so the placeholder stays visible when the
    // pointer briefly leaves a column
    return null;
  }

  const columnId = getID(
    columnEl,
    'data-kanban-column-cards'
  ) as ColumnID | null;
  if (columnId == null) return null;

  const viewData = a.store.getState().viewData;
  const column = viewData.columns.find((c: ColumnView) => c.id === columnId);
  if (!column) return null;

  const cardEls = Array.from(
    columnEl.querySelectorAll<HTMLElement>('[data-kanban-card-id]')
  ).filter((n) => getID(n, 'data-kanban-card-id') !== a.id);

  let beforeId: CardID | null = null;
  for (const cardEl of cardEls) {
    const rect = cardEl.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      beforeId = resolveRenderedCardId(
        column,
        getID(cardEl, 'data-kanban-card-id') as CardID | null
      );
      break;
    }
  }

  if (beforeId == null) {
    beforeId = resolveRenderedCardId(
      column,
      getID(columnEl, 'data-kanban-after-rendered-before-id') as CardID | null
    );
  }

  const next = { column: column.id, beforeId };
  const prev = a.dnd.target;
  if (!prev || prev.column !== next.column || prev.beforeId !== next.beforeId) {
    a.dnd.target = next;
  }
  return columnEl;
}

function resolveRenderedCardId(
  column: ColumnView,
  id: CardID | null
): CardID | null {
  if (id == null) return null;
  return column.cards.find((card) => card.id === id)?.id ?? null;
}

function commitDrop(a: Resolved) {
  const target = a.dnd.target;
  if (!target) return;
  if (target.column === a.column && target.beforeId === originalBeforeId(a))
    return;

  const payload: { id: CardID; column?: ColumnID; before?: CardID | null } = {
    id: a.id,
    column: target.column
  };
  if (target.beforeId != null) payload.before = target.beforeId;

  void a.store.exec('move-card', payload);
}

function originalBeforeId(a: Resolved): CardID | null {
  const column = a.store
    .getState()
    .viewData.columns.find((item: ColumnView) => item.id === a.column);
  if (!column) return null;

  const index = column.cards.findIndex((card: KanbanCard) => card.id === a.id);
  return index >= 0 ? (column.cards[index + 1]?.id ?? null) : null;
}

function suppressNextClick() {
  const handler = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener('click', handler, true);
  };
  window.addEventListener('click', handler, true);
  // if no click follows (pointerup without a click event), drop the listener
  // on the next tick so it doesn't swallow a later unrelated click.
  setTimeout(() => window.removeEventListener('click', handler, true), 0);
}
