import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppHeightController, keyboardInset } from './app-height';

const WINDOW_HEIGHT = 800;
const KEYBOARD_HEIGHT = 300;

/**
 * A window reduced to what the controller touches. `visualViewport` is a
 * tiny event target whose `height` / `offsetTop` the test drives to play a
 * soft keyboard opening and closing.
 */
function fakeWindow({ withViewport = true } = {}) {
  const listeners: Record<string, Set<() => void>> = {};
  const vv = {
    height: WINDOW_HEIGHT,
    offsetTop: 0,
    addEventListener(type: string, fn: () => void) {
      (listeners[type] ??= new Set()).add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners[type]?.delete(fn);
    }
  };
  const style: Record<string, string> = {};
  const root = {
    scrollTop: 0,
    style: {
      setProperty: (name: string, value: string) => {
        style[name] = value;
      },
      removeProperty: (name: string) => {
        delete style[name];
      }
    }
  };
  const body = { scrollTop: 0 };
  const win = {
    innerHeight: WINDOW_HEIGHT,
    visualViewport: withViewport ? vv : null,
    document: { documentElement: root, body },
    // Resolved per call so vitest's fake timers apply.
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
  };
  return {
    win: win as unknown as Window,
    root,
    body,
    /** `--app-h` as currently published, or undefined when cleared. */
    appHeight: () => style['--app-h'],
    listenerCount: (type: string) => listeners[type]?.size ?? 0,
    /** Resize the visual viewport as a keyboard would, then notify. */
    setKeyboard(height: number) {
      vv.height = WINDOW_HEIGHT - height;
      for (const fn of [...(listeners.resize ?? [])]) fn();
    },
    /** Pan the visual viewport without resizing it, then notify. */
    pan(offsetTop: number) {
      vv.offsetTop = offsetTop;
      for (const fn of [...(listeners.scroll ?? [])]) fn();
    }
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('keyboardInset', () => {
  it('is zero with no keyboard up', () => {
    expect(keyboardInset(fakeWindow().win)).toBe(0);
  });

  it('is the height the keyboard takes off the visual viewport', () => {
    const fake = fakeWindow();
    fake.setKeyboard(KEYBOARD_HEIGHT);
    expect(keyboardInset(fake.win)).toBe(KEYBOARD_HEIGHT);
  });

  it('discounts a pan, leaving the gap below the visible area', () => {
    const fake = fakeWindow();
    fake.setKeyboard(KEYBOARD_HEIGHT);
    fake.pan(120);
    expect(keyboardInset(fake.win)).toBe(KEYBOARD_HEIGHT - 120);
  });

  it('never goes negative', () => {
    const fake = fakeWindow();
    fake.pan(50);
    expect(keyboardInset(fake.win)).toBe(0);
  });

  it('is zero without a visual viewport', () => {
    expect(keyboardInset(fakeWindow({ withViewport: false }).win)).toBe(0);
  });
});

describe('createAppHeightController', () => {
  it('publishes the visible height and follows the keyboard', () => {
    const fake = fakeWindow();
    createAppHeightController(fake.win);
    expect(fake.appHeight()).toBe(`${WINDOW_HEIGHT}px`);

    fake.setKeyboard(KEYBOARD_HEIGHT);
    expect(fake.appHeight()).toBe(`${WINDOW_HEIGHT - KEYBOARD_HEIGHT}px`);

    fake.setKeyboard(0);
    expect(fake.appHeight()).toBe(`${WINDOW_HEIGHT}px`);
  });

  it('resets a scroll the browser applied to reveal a focused field', () => {
    const fake = fakeWindow();
    createAppHeightController(fake.win);
    fake.root.scrollTop = 140;
    fake.body.scrollTop = 60;
    fake.setKeyboard(KEYBOARD_HEIGHT);
    expect(fake.root.scrollTop).toBe(0);
    expect(fake.body.scrollTop).toBe(0);
  });

  it('does nothing without a visual viewport', () => {
    const fake = fakeWindow({ withViewport: false });
    const controller = createAppHeightController(fake.win);
    const release = controller.hold();
    release();
    expect(fake.appHeight()).toBeUndefined();
  });
});

describe('hold', () => {
  it('keeps the shell at full height while the keyboard opens', () => {
    const fake = fakeWindow();
    const controller = createAppHeightController(fake.win);
    controller.hold();
    // Cleared, so the 100% default in app.css applies.
    expect(fake.appHeight()).toBeUndefined();

    fake.setKeyboard(KEYBOARD_HEIGHT);
    expect(fake.appHeight()).toBeUndefined();
  });

  it('still resets a browser scroll while held', () => {
    const fake = fakeWindow();
    const controller = createAppHeightController(fake.win);
    controller.hold();
    fake.root.scrollTop = 140;
    fake.setKeyboard(KEYBOARD_HEIGHT);
    expect(fake.root.scrollTop).toBe(0);
  });

  it('follows the viewport again right away when no keyboard is up', () => {
    const fake = fakeWindow();
    const controller = createAppHeightController(fake.win);
    const release = controller.hold();
    release();
    expect(fake.appHeight()).toBe(`${WINDOW_HEIGHT}px`);
  });

  it('waits for the keyboard to close before following it again', () => {
    const fake = fakeWindow();
    const controller = createAppHeightController(fake.win);
    const release = controller.hold();
    fake.setKeyboard(KEYBOARD_HEIGHT);

    release();
    // Still up: publishing now would shrink the shell for a few frames.
    expect(fake.appHeight()).toBeUndefined();

    // Halfway through the closing animation.
    fake.setKeyboard(KEYBOARD_HEIGHT / 2);
    expect(fake.appHeight()).toBeUndefined();

    fake.setKeyboard(0);
    expect(fake.appHeight()).toBe(`${WINDOW_HEIGHT}px`);
  });

  it('gives up waiting when the keyboard stays for another field', () => {
    const fake = fakeWindow();
    const controller = createAppHeightController(fake.win);
    const release = controller.hold();
    fake.setKeyboard(KEYBOARD_HEIGHT);
    release();
    expect(fake.appHeight()).toBeUndefined();

    vi.advanceTimersByTime(600);
    expect(fake.appHeight()).toBe(`${WINDOW_HEIGHT - KEYBOARD_HEIGHT}px`);
  });

  it('removes its wait listener once settled, by event or by timer', () => {
    const fake = fakeWindow();
    const controller = createAppHeightController(fake.win);
    const baseline = fake.listenerCount('resize');

    const byEvent = controller.hold();
    fake.setKeyboard(KEYBOARD_HEIGHT);
    byEvent();
    expect(fake.listenerCount('resize')).toBe(baseline + 1);
    fake.setKeyboard(0);
    expect(fake.listenerCount('resize')).toBe(baseline);

    const byTimer = controller.hold();
    fake.setKeyboard(KEYBOARD_HEIGHT);
    byTimer();
    vi.advanceTimersByTime(600);
    expect(fake.listenerCount('resize')).toBe(baseline);
    // The settled timer must not fire a second finish later.
    fake.setKeyboard(0);
    expect(fake.appHeight()).toBe(`${WINDOW_HEIGHT}px`);
  });

  it('nests: the shell stays held until the last release', () => {
    const fake = fakeWindow();
    const controller = createAppHeightController(fake.win);
    const first = controller.hold();
    const second = controller.hold();
    first();
    expect(fake.appHeight()).toBeUndefined();
    second();
    expect(fake.appHeight()).toBe(`${WINDOW_HEIGHT}px`);
  });

  it('ignores a second call to the same release', () => {
    const fake = fakeWindow();
    const controller = createAppHeightController(fake.win);
    const outer = controller.hold();
    const inner = controller.hold();
    inner();
    inner();
    // A double release must not eat the outer hold.
    expect(fake.appHeight()).toBeUndefined();
    outer();
    expect(fake.appHeight()).toBe(`${WINDOW_HEIGHT}px`);
  });
});
