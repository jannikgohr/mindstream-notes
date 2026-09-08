import { RESIZE_SNAPSHOT_RESTORE_SUPPRESS_MS } from './editor-helpers';

const SNAPSHOT_HIDE_DELAY_MS = 120;

interface EventSource {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

interface DocumentEventSource extends EventSource {
  visibilityState: string;
}

interface ResizeObserverLike {
  observe(target: Element): void;
  disconnect(): void;
}

export interface CanvasResizeRuntime {
  windowTarget: EventSource;
  documentTarget: DocumentEventSource;
  visualViewportTarget: EventSource | null;
  now(): number;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
  setDelay(
    callback: () => void,
    delayMs: number
  ): ReturnType<typeof setTimeout>;
  clearDelay(handle: ReturnType<typeof setTimeout>): void;
  createResizeObserver(callback: () => void): ResizeObserverLike;
}

export function createCanvasResizeLifecycle(options: {
  sourceCanvas(): HTMLCanvasElement | null;
  snapshotCanvas(): HTMLCanvasElement | null;
  hasDrawnFrame(): boolean;
  resizeCanvas(): void;
  pushBounds(): void;
  setSnapshotVisible(visible: boolean): void;
  runtime?: CanvasResizeRuntime;
}) {
  let runtime: CanvasResizeRuntime | null = options.runtime ?? null;
  let observer: ResizeObserverLike | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let restoreFrame: number | null = null;
  let snapshotVisible = false;
  let suppressedUntil = 0;

  const env = () => (runtime ??= browserRuntime());

  function setVisible(visible: boolean): void {
    if (snapshotVisible === visible) return;
    snapshotVisible = visible;
    options.setSnapshotVisible(visible);
  }

  function cancelHide(): void {
    if (hideTimer === null) return;
    env().clearDelay(hideTimer);
    hideTimer = null;
  }

  function captureSnapshot(): boolean {
    const current = env();
    const source = options.sourceCanvas();
    const snapshot = options.snapshotCanvas();
    if (
      current.now() < suppressedUntil ||
      current.documentTarget.visibilityState !== 'visible' ||
      !options.hasDrawnFrame() ||
      !source ||
      !snapshot ||
      source.width <= 1 ||
      source.height <= 1
    ) {
      return false;
    }
    const ctx = snapshot.getContext('2d');
    if (!ctx) return false;
    if (snapshot.width !== source.width || snapshot.height !== source.height) {
      snapshot.width = source.width;
      snapshot.height = source.height;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, snapshot.width, snapshot.height);
    ctx.drawImage(source, 0, 0);
    snapshot.style.opacity = '1';
    cancelHide();
    setVisible(true);
    return true;
  }

  function clearSnapshot(): void {
    cancelHide();
    setVisible(false);
    const snapshot = options.snapshotCanvas();
    if (!snapshot) return;
    snapshot.style.opacity = '';
    snapshot.getContext('2d')?.clearRect(0, 0, snapshot.width, snapshot.height);
  }

  function suppressSnapshot(
    durationMs = RESIZE_SNAPSHOT_RESTORE_SUPPRESS_MS
  ): void {
    suppressedUntil = Math.max(suppressedUntil, env().now() + durationMs);
    clearSnapshot();
  }

  function restoreBoundary(): void {
    suppressSnapshot();
    if (restoreFrame !== null) return;
    restoreFrame = env().requestFrame(() => {
      restoreFrame = null;
      options.resizeCanvas();
      options.pushBounds();
    });
  }

  function visibilityChanged(): void {
    if (env().documentTarget.visibilityState === 'visible') {
      restoreBoundary();
    } else {
      suppressSnapshot(RESIZE_SNAPSHOT_RESTORE_SUPPRESS_MS * 2);
    }
  }

  function scheduleSnapshotHide(): void {
    if (!snapshotVisible) return;
    cancelHide();
    hideTimer = env().setDelay(() => {
      hideTimer = null;
      setVisible(false);
      const snapshot = options.snapshotCanvas();
      if (snapshot) snapshot.style.opacity = '';
    }, SNAPSHOT_HIDE_DELAY_MS);
  }

  const resizeAndPush = () => {
    options.resizeCanvas();
    options.pushBounds();
  };
  const pushBounds = () => options.pushBounds();

  function start(canvasHost: Element | null, toolbar: Element | null): void {
    if (observer) return;
    const current = env();
    observer = current.createResizeObserver(resizeAndPush);
    if (canvasHost) observer.observe(canvasHost);
    if (toolbar) observer.observe(toolbar);
    current.windowTarget.addEventListener('resize', pushBounds);
    current.windowTarget.addEventListener('focus', restoreBoundary);
    current.windowTarget.addEventListener('pageshow', restoreBoundary);
    current.documentTarget.addEventListener(
      'visibilitychange',
      visibilityChanged
    );
    current.visualViewportTarget?.addEventListener('resize', pushBounds);
    current.visualViewportTarget?.addEventListener('scroll', pushBounds);
  }

  function destroy(): void {
    const current = env();
    current.windowTarget.removeEventListener('resize', pushBounds);
    current.windowTarget.removeEventListener('focus', restoreBoundary);
    current.windowTarget.removeEventListener('pageshow', restoreBoundary);
    current.documentTarget.removeEventListener(
      'visibilitychange',
      visibilityChanged
    );
    current.visualViewportTarget?.removeEventListener('resize', pushBounds);
    current.visualViewportTarget?.removeEventListener('scroll', pushBounds);
    observer?.disconnect();
    observer = null;
    if (restoreFrame !== null) {
      current.cancelFrame(restoreFrame);
      restoreFrame = null;
    }
    clearSnapshot();
  }

  return {
    start,
    captureSnapshot,
    suppressSnapshot,
    scheduleSnapshotHide,
    destroy
  };
}

function browserRuntime(): CanvasResizeRuntime {
  return {
    windowTarget: window as unknown as EventSource,
    documentTarget: document as unknown as DocumentEventSource,
    visualViewportTarget:
      window.visualViewport as unknown as EventSource | null,
    now: () => performance.now(),
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    setDelay: (callback, delayMs) => setTimeout(callback, delayMs),
    clearDelay: (handle) => clearTimeout(handle),
    createResizeObserver: (callback) => new ResizeObserver(callback)
  };
}
