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
  let disposed = false;
  const cancelled = new Set<string>();
  async function receive(notice: { id: string; phase: 'prepare' | 'cancel' }) {
    if (disposed) return;
    if (notice.phase === 'cancel') {
      cancelled.add(notice.id);
      if (cancelled.size > 64)
        cancelled.delete(cancelled.values().next().value!);
      if (notice.id === '00000000-0000-0000-0000-000000000000') {
        options.failed();
      } else if (active === notice.id) {
        active = null;
        restore?.();
        restore = null;
        options.failed();
      }
      return;
    }
    // Cancellation may reach a window before its queued prepare notification.
    if (cancelled.has(notice.id) || active === notice.id) return;
    restore?.();
    active = notice.id;
    try {
      restore = options.freeze();
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
    restore?.();
    restore = null;
    if (id) void options.acknowledge(id, false).catch(options.onError);
  }
  return { receive, dispose };
}
