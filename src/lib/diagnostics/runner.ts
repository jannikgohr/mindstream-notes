import { isAbortError } from './bus';

interface DiagnosticRunnerOptions {
  debounceMs: number;
  enabled?(): boolean;
  clear(): void;
  run(context: {
    signal: AbortSignal;
    publish(action: () => void): void;
  }): Promise<void>;
}

/** Owns scheduling and delivery eligibility; editor snapshots stay in adapters. */
export function createDiagnosticRunner(options: DiagnosticRunnerOptions) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: AbortController | null = null;
  let pending = false;
  let disposed = false;

  const cancelTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const enabled = () => options.enabled?.() !== false;

  const launch = () => {
    if (disposed) return;
    cancelTimer();
    if (!enabled()) {
      pending = false;
      options.clear();
      return;
    }
    if (active) {
      pending = true;
      return;
    }
    pending = false;
    const controller = new AbortController();
    active = controller;
    void (async () => {
      try {
        await options.run({
          signal: controller.signal,
          publish(action) {
            if (
              !disposed &&
              active === controller &&
              !controller.signal.aborted
            )
              action();
          }
        });
      } catch (error) {
        if (!isAbortError(error))
          console.error('Diagnostics check failed', error);
      } finally {
        active = null;
        if (pending && !disposed) launch();
      }
    })();
  };

  return {
    start() {
      if (disposed) return;
      cancelTimer();
      timer = setTimeout(launch, 0);
    },
    documentChanged() {
      if (disposed) return;
      if (active) pending = true;
      cancelTimer();
      timer = setTimeout(launch, options.debounceMs);
    },
    invalidate() {
      if (disposed) return;
      cancelTimer();
      pending = enabled();
      const previous = active;
      // Abort listeners may reenter any runner method.
      previous?.abort();
      if (disposed) return;
      if (!enabled()) {
        pending = false;
        options.clear();
      } else if (!active) launch();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      pending = false;
      cancelTimer();
      active?.abort();
    }
  };
}
