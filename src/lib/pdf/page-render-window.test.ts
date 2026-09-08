import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageRenderWindow } from './page-render-window';
import { RENDER_DROP_DELAY_MS } from './viewer-helpers';

const observers: FakeObserver[] = [];
class FakeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(private callback: IntersectionObserverCallback) {
    observers.push(this);
  }
  emit(page: number, ratio: number) {
    const target = document.createElement('figure');
    target.dataset.pageNumber = String(page);
    this.callback(
      [
        {
          target,
          intersectionRatio: ratio,
          isIntersecting: ratio > 0
        } as unknown as IntersectionObserverEntry
      ],
      this as unknown as IntersectionObserver
    );
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', FakeObserver);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup() {
  let active = 1;
  const onChange = vi.fn();
  const ensurePageSize = vi.fn(async () => {});
  const controller = createPageRenderWindow({
    getActivePage: () => active,
    setActivePage: (page) => {
      active = page;
    },
    ensurePageSize,
    onChange
  });
  const root = document.createElement('div');
  root.innerHTML = '<figure data-page-number="1"></figure>';
  return { controller, root, onChange, ensurePageSize, active: () => active };
}

describe('PDF page render window', () => {
  it('cancels offscreen work immediately, restarts on quick re-entry, and evicts after the grace period', async () => {
    const { controller, root, ensurePageSize } = setup();
    controller.observe(root, Promise.resolve());
    await Promise.resolve();
    const cancel = vi.fn();
    controller.cancelHooks.set(1, cancel);
    observers[1].emit(1, 1);
    expect(controller.isRendering(1)).toBe(true);
    expect(ensurePageSize).toHaveBeenCalledWith(1);
    observers[1].emit(1, 0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(controller.isRendering(1)).toBe(true);
    await vi.advanceTimersByTimeAsync(RENDER_DROP_DELAY_MS - 1);
    observers[1].emit(1, 1);
    expect(controller.invalidationOf(1)).toBe(1);
    await vi.advanceTimersByTimeAsync(RENDER_DROP_DELAY_MS);
    expect(controller.isRendering(1)).toBe(true);
    observers[1].emit(1, 0);
    await vi.advanceTimersByTimeAsync(RENDER_DROP_DELAY_MS);
    expect(controller.isRendering(1)).toBe(false);
    controller.destroy();
  });

  it('selects the most visible page and breaks ties by page number', () => {
    const { controller, root, active } = setup();
    controller.observe(root, Promise.resolve());
    observers[0].emit(3, 0.5);
    observers[0].emit(2, 0.5);
    expect(active()).toBe(2);
    observers[0].emit(3, 0.75);
    expect(active()).toBe(3);
    observers[0].emit(3, 0);
    expect(active()).toBe(2);
    controller.destroy();
  });

  it('does not attach after teardown or let stale callbacks mutate a replacement window', async () => {
    const { controller, root, onChange } = setup();
    let ready!: () => void;
    const stop = controller.observe(
      root,
      new Promise<void>((resolve) => {
        ready = resolve;
      })
    );
    observers[1].emit(1, 1);
    observers[1].emit(1, 0);
    controller.observe(root, Promise.resolve());
    ready();
    await Promise.resolve();
    expect(observers[0].observe).not.toHaveBeenCalled();
    expect(observers[2].observe).toHaveBeenCalledOnce();
    observers[3].emit(1, 1);
    stop();
    observers[1].emit(1, 0);
    await vi.advanceTimersByTimeAsync(RENDER_DROP_DELAY_MS);
    expect(controller.isRendering(1)).toBe(true);
    controller.destroy();
    const changes = onChange.mock.calls.length;
    observers[3].emit(1, 1);
    await vi.runAllTimersAsync();
    expect(onChange).toHaveBeenCalledTimes(changes);
    expect(controller.isRendering(1)).toBe(false);
    expect(
      observers.every((observer) => observer.disconnect.mock.calls.length === 1)
    ).toBe(true);
  });
});
