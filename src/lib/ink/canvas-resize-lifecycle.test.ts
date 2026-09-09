import { describe, expect, it, vi } from 'vitest';
import {
  createCanvasResizeLifecycle,
  type CanvasResizeRuntime
} from './canvas-resize-lifecycle';

class Events {
  visibilityState = 'visible';
  private listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }
}

function harness() {
  const windowTarget = new Events();
  const documentTarget = new Events();
  const visualViewportTarget = new Events();
  const frames = new Map<number, FrameRequestCallback>();
  const delays = new Map<number, () => void>();
  const observed: Element[] = [];
  const disconnect = vi.fn();
  let resizeCallback = () => {};
  let now = 0;
  let nextHandle = 1;
  const runtime: CanvasResizeRuntime = {
    windowTarget,
    documentTarget,
    visualViewportTarget,
    now: () => now,
    requestFrame(callback) {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => {
      frames.delete(handle);
    },
    setDelay(callback) {
      const handle = nextHandle++;
      delays.set(handle, callback);
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearDelay: (handle) => {
      delays.delete(handle as unknown as number);
    },
    createResizeObserver(callback) {
      resizeCallback = callback;
      return {
        observe: (target) => observed.push(target),
        disconnect
      };
    }
  };
  return {
    runtime,
    windowTarget,
    documentTarget,
    visualViewportTarget,
    frames,
    delays,
    observed,
    disconnect,
    resize: () => resizeCallback(),
    advanceTo: (value: number) => {
      now = value;
    },
    runFrames: () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(now);
    },
    runDelays: () => {
      const pending = [...delays.values()];
      delays.clear();
      for (const callback of pending) callback();
    }
  };
}

function canvases() {
  const operations: string[] = [];
  const context = {
    setTransform: () => operations.push('transform'),
    clearRect: () => operations.push('clear'),
    drawImage: () => operations.push('copy')
  } as unknown as CanvasRenderingContext2D;
  const source = { width: 640, height: 480 } as HTMLCanvasElement;
  const snapshot = {
    width: 1,
    height: 1,
    style: { opacity: '' },
    getContext: () => context
  } as unknown as HTMLCanvasElement;
  return { source, snapshot, operations };
}

describe('canvas resize lifecycle', () => {
  it('copies a drawn frame during resize and hides it after the replacement frame', () => {
    const h = harness();
    const canvas = canvases();
    const visible = vi.fn();
    const lifecycle = createCanvasResizeLifecycle({
      sourceCanvas: () => canvas.source,
      snapshotCanvas: () => canvas.snapshot,
      hasDrawnFrame: () => true,
      resizeCanvas: vi.fn(),
      pushBounds: vi.fn(),
      setSnapshotVisible: visible,
      runtime: h.runtime
    });

    expect(lifecycle.captureSnapshot()).toBe(true);
    expect(canvas.snapshot.width).toBe(640);
    expect(canvas.snapshot.height).toBe(480);
    expect(canvas.operations).toEqual(['transform', 'clear', 'copy']);
    expect(canvas.snapshot.style.opacity).toBe('1');
    expect(visible).toHaveBeenLastCalledWith(true);

    lifecycle.scheduleSnapshotHide();
    expect(h.delays.size).toBe(1);
    h.runDelays();
    expect(canvas.snapshot.style.opacity).toBe('');
    expect(visible).toHaveBeenLastCalledWith(false);
  });

  it('owns resize listeners, restore suppression, and teardown', () => {
    const h = harness();
    const canvas = canvases();
    const resizeCanvas = vi.fn();
    const pushBounds = vi.fn();
    const host = {} as Element;
    const toolbar = {} as Element;
    const lifecycle = createCanvasResizeLifecycle({
      sourceCanvas: () => canvas.source,
      snapshotCanvas: () => canvas.snapshot,
      hasDrawnFrame: () => true,
      resizeCanvas,
      pushBounds,
      setSnapshotVisible: vi.fn(),
      runtime: h.runtime
    });

    lifecycle.start(host, toolbar);
    expect(h.observed).toEqual([host, toolbar]);
    h.resize();
    expect(resizeCanvas).toHaveBeenCalledOnce();
    expect(pushBounds).toHaveBeenCalledOnce();

    h.windowTarget.dispatch('resize');
    h.visualViewportTarget.dispatch('scroll');
    expect(pushBounds).toHaveBeenCalledTimes(3);

    expect(lifecycle.captureSnapshot()).toBe(true);
    h.windowTarget.dispatch('focus');
    expect(canvas.snapshot.style.opacity).toBe('');
    expect(h.frames.size).toBe(1);
    h.runFrames();
    expect(resizeCanvas).toHaveBeenCalledTimes(2);
    expect(pushBounds).toHaveBeenCalledTimes(4);

    lifecycle.destroy();
    expect(h.disconnect).toHaveBeenCalledOnce();
    h.windowTarget.dispatch('resize');
    h.windowTarget.dispatch('focus');
    h.visualViewportTarget.dispatch('scroll');
    expect(pushBounds).toHaveBeenCalledTimes(4);
    expect(h.frames.size).toBe(0);
  });

  it('does not reuse a stale snapshot across a hidden document restore', () => {
    const h = harness();
    const canvas = canvases();
    const lifecycle = createCanvasResizeLifecycle({
      sourceCanvas: () => canvas.source,
      snapshotCanvas: () => canvas.snapshot,
      hasDrawnFrame: () => true,
      resizeCanvas: vi.fn(),
      pushBounds: vi.fn(),
      setSnapshotVisible: vi.fn(),
      runtime: h.runtime
    });
    lifecycle.start(null, null);
    expect(lifecycle.captureSnapshot()).toBe(true);

    h.documentTarget.visibilityState = 'hidden';
    h.documentTarget.dispatch('visibilitychange');
    expect(canvas.snapshot.style.opacity).toBe('');
    h.documentTarget.visibilityState = 'visible';
    h.documentTarget.dispatch('visibilitychange');
    h.runFrames();
    expect(lifecycle.captureSnapshot()).toBe(false);

    h.advanceTo(701);
    expect(lifecycle.captureSnapshot()).toBe(true);
  });
});
