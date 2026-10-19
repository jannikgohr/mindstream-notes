import { cleanup, render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PageOverlayScrollbar from './page-overlay-scrollbar.svelte';

const observers: { callback: () => void; disconnect: () => void }[] = [];

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      callback: () => void;
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(callback: () => void) {
        this.callback = callback;
        observers.push(this);
      }
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function scroller(scrollHeight: number): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientHeight', { value: 100 });
  Object.defineProperty(el, 'scrollHeight', {
    value: scrollHeight,
    writable: true
  });
  return el;
}

describe('PageOverlayScrollbar', () => {
  it('keeps one observer when its callback turns the overflow on', () => {
    const el = scroller(100);
    // `target` is also a render option, so pass props explicitly.
    render(PageOverlayScrollbar, { props: { target: el } });
    flushSync();
    expect(observers).toHaveLength(1);

    // Content laid out after mount: the first resize report finds overflow.
    Object.defineProperty(el, 'scrollHeight', { value: 400 });
    observers[0].callback();
    flushSync();

    // Re-observing inside the resize delivery is what made Chromium report
    // "ResizeObserver loop completed with undelivered notifications".
    expect(observers).toHaveLength(1);
    expect(observers[0].disconnect).not.toHaveBeenCalled();
  });
});
