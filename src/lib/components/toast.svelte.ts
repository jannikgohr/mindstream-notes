/**
 * App-wide ephemeral toasts — the transient "it worked" / "it didn't"
 * confirmations that are too fleeting to belong in the persistent
 * notification center. A single `ToastHost` (mounted in LazyRootSingletons)
 * renders whatever is in `toasts.items`; anywhere else in the app calls
 * `pushToast` and forgets about it.
 *
 * Lives in a `.svelte.ts` because the queue is a `$state` rune the host reads
 * reactively. The auto-dismiss timer is owned here rather than in the host so a
 * toast's lifetime is independent of whether the host happens to be mounted at
 * the moment it fires.
 */

export type ToastVariant = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
}

/** How long a toast stays up before auto-dismissing. */
export const TOAST_DURATION_MS = 4000;

export const toasts = $state<{ items: Toast[] }>({ items: [] });

let nextId = 0;

/**
 * Show a toast. Returns its id so a caller can dismiss it early. `durationMs` of
 * 0 keeps it up until dismissed manually (used for anything the user must
 * acknowledge); otherwise it auto-dismisses.
 */
export function pushToast(
  message: string,
  opts: { variant?: ToastVariant; durationMs?: number } = {}
): number {
  const id = ++nextId;
  toasts.items.push({ id, message, variant: opts.variant ?? 'info' });

  const duration = opts.durationMs ?? TOAST_DURATION_MS;
  // Guard on `window` so a toast pushed during SSR/prerender doesn't schedule a
  // timer that never runs; the item simply isn't rendered server-side anyway.
  if (duration > 0 && typeof window !== 'undefined') {
    window.setTimeout(() => dismissToast(id), duration);
  }
  return id;
}

export function dismissToast(id: number): void {
  const index = toasts.items.findIndex((t) => t.id === id);
  if (index !== -1) toasts.items.splice(index, 1);
}
