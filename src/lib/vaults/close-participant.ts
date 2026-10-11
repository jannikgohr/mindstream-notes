/** Keep a window frozen until the native owner commits or cancels this close. */
export function createCloseParticipant(options: {
  flush: () => Promise<void>;
  acknowledge: (id: string, saved: boolean) => Promise<void>;
  freeze: () => () => void;
  failed: () => void;
  onError: (error: unknown) => void;
}) {
  let active: string | null = null;
  let restore: (() => void) | null = null;
  let preparing = false;
  let disposed = false;
  const cancelled = new Set<string>();
  async function receive(notice: {
    id: string;
    phase: 'waiting' | 'prepare' | 'cancel';
  }) {
    if (disposed) return;
    if (notice.phase === 'cancel') {
      cancelled.add(notice.id);
      if (cancelled.size > 64)
        cancelled.delete(cancelled.values().next().value!);
      if (notice.id === '00000000-0000-0000-0000-000000000000') {
        options.failed();
      } else if (active === notice.id) {
        active = null;
        preparing = false;
        restore?.();
        restore = null;
        options.failed();
      }
      return;
    }
    // Cancellation may reach a window before its queued prepare notification.
    if (cancelled.has(notice.id)) return;
    if (notice.phase !== 'waiting' && notice.phase !== 'prepare') return;
    if (active === notice.id && (preparing || notice.phase === 'waiting'))
      return;
    try {
      if (active !== notice.id) {
        restore?.();
        active = notice.id;
        preparing = false;
        restore = options.freeze();
      }
      // Freeze immediately, but take the final editor snapshot only after
      // services have completed and emitted their last content updates.
      if (notice.phase === 'waiting') return;
      preparing = true;
      await options.flush();
      if (active === notice.id && !disposed) {
        await options.acknowledge(notice.id, true);
      }
    } catch (error) {
      options.onError(error);
      if (active === notice.id && !disposed) {
        // A lost success reply may already have committed. Only native cancel
        // can unfreeze; releasing input here would let edits race native exit.
        try {
          await options.acknowledge(notice.id, false);
        } catch (ackError) {
          options.onError(ackError);
        }
      }
    }
  }
  function dispose() {
    disposed = true;
    const id = active;
    active = null;
    preparing = false;
    restore?.();
    restore = null;
    if (id) void options.acknowledge(id, false).catch(options.onError);
  }
  return { receive, dispose };
}
