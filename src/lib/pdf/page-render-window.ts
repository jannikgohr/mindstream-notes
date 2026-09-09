import { RENDER_DROP_DELAY_MS, RENDER_ROOT_MARGIN } from './viewer-helpers';

/** Owns page visibility, render cancellation, and delayed canvas eviction. */
export function createPageRenderWindow(options: {
  getActivePage: () => number;
  setActivePage: (page: number) => void;
  ensurePageSize: (page: number) => Promise<void>;
  onChange: () => void;
}) {
  const rendered = new Set<number>();
  const invalidations = new Map<number, number>();
  const cancelHooks = new Map<number, () => void>();
  let stop: (() => void) | null = null;

  function observe(root: HTMLElement, ready: Promise<void>) {
    stop?.();
    let closed = false;
    const visibility = new Map<number, number>();
    const cancelled = new Set<number>();
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    const pageNumber = (entry: IntersectionObserverEntry) =>
      Number((entry.target as HTMLElement).dataset.pageNumber);
    const visibleObserver = new IntersectionObserver(
      (entries) => {
        if (closed) return;
        for (const entry of entries) {
          const page = pageNumber(entry);
          if (!Number.isInteger(page) || page < 1) continue;
          if (entry.intersectionRatio > 0)
            visibility.set(page, entry.intersectionRatio);
          else visibility.delete(page);
        }
        let best = options.getActivePage();
        let bestRatio = -1;
        for (const [page, ratio] of visibility) {
          if (ratio > bestRatio || (ratio === bestRatio && page < best)) {
            best = page;
            bestRatio = ratio;
          }
        }
        if (best !== options.getActivePage()) options.setActivePage(best);
      },
      { root, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] }
    );
    const renderObserver = new IntersectionObserver(
      (entries) => {
        if (closed) return;
        let changed = false;
        for (const entry of entries) {
          const page = pageNumber(entry);
          if (!Number.isInteger(page) || page < 1) continue;
          if (entry.isIntersecting) {
            void options.ensurePageSize(page).catch((error) => {
              console.warn('[pdf] page size lookup failed', error);
            });
            const timer = timers.get(page);
            if (timer !== undefined) clearTimeout(timer);
            timers.delete(page);
            if (cancelled.delete(page)) {
              invalidations.set(page, (invalidations.get(page) ?? 0) + 1);
              changed = true;
            }
            if (!rendered.has(page)) {
              rendered.add(page);
              changed = true;
            }
          } else if (rendered.has(page)) {
            cancelHooks.get(page)?.();
            cancelled.add(page);
            if (timers.has(page)) continue;
            timers.set(
              page,
              setTimeout(() => {
                timers.delete(page);
                cancelled.delete(page);
                if (rendered.delete(page)) options.onChange();
              }, RENDER_DROP_DELAY_MS)
            );
          }
        }
        if (changed) options.onChange();
      },
      { root, rootMargin: RENDER_ROOT_MARGIN, threshold: 0 }
    );
    const cleanup = () => {
      if (closed) return;
      closed = true;
      visibleObserver.disconnect();
      renderObserver.disconnect();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      visibility.clear();
      cancelled.clear();
      rendered.clear();
      options.onChange();
      if (stop === cleanup) stop = null;
    };
    stop = cleanup;
    // A replaced or destroyed viewer must not attach observers after tick().
    void ready
      .then(() => {
        if (closed) return;
        root
          .querySelectorAll<HTMLElement>('figure[data-page-number]')
          .forEach((target) => {
            visibleObserver.observe(target);
            renderObserver.observe(target);
          });
      })
      .catch((error) => {
        cleanup();
        console.warn('[pdf] page observation failed', error);
      });
    return cleanup;
  }

  return {
    observe,
    cancelHooks,
    isRendering: (page: number) => rendered.has(page),
    invalidationOf: (page: number) => invalidations.get(page) ?? 0,
    destroy() {
      stop?.();
      cancelHooks.clear();
      invalidations.clear();
    }
  };
}
