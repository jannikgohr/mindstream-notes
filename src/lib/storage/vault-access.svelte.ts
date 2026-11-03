/**
 * Whether this window may write to storage.
 *
 * A window writes only after it holds its vault and has loaded the vault's
 * notes. Until then it cannot tell a deleted folder from one it simply has
 * not read, and in the browser it may not own the vault at all: a second tab
 * is refused the database lock but still runs the whole app. Every storage
 * path asks this module first, so a window that does not own its vault never
 * changes the vault, the app's settings or anything else another window
 * reads.
 *
 *   - `pending`: the vault has not finished opening. A write waits. If
 *     nothing is loading the vault, the write starts the load through the
 *     probe the tree store registers.
 *   - `ready`: the vault lock is held and the notes loaded. Writes go ahead.
 *   - `unavailable`: the last load failed. Writes are refused until a load
 *     succeeds.
 *
 * The tree store reports every load result, and the browser vault reports a
 * lost connection, which returns the window to `pending`.
 */

export type VaultAccessStatus = 'pending' | 'ready' | 'unavailable';

/** A write that this window may not make, because it does not own its vault. */
export class VaultNotReadyError extends Error {
  readonly code = 'vaultNotReady';
  constructor(
    readonly operation: string,
    readonly reason: string | null
  ) {
    super(
      reason
        ? `${operation} was not saved: the vault is not open in this window (${reason})`
        : `${operation} was not saved: the vault is not open in this window`
    );
    this.name = 'VaultNotReadyError';
  }
}

const state = $state<{ status: VaultAccessStatus; reason: string | null }>({
  status: 'pending',
  reason: null
});

/** The current access state. Reactive. */
export const vaultAccess: {
  readonly status: VaultAccessStatus;
  readonly reason: string | null;
} = {
  get status() {
    return state.status;
  },
  get reason() {
    return state.reason;
  }
};

type Listener = (
  status: VaultAccessStatus,
  previous: VaultAccessStatus
) => void;
// Bookkeeping, never rendered.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const listeners = new Set<Listener>();
let waiters: { resolve: () => void; reject: (error: unknown) => void }[] = [];
let probe: (() => Promise<void>) | null = null;
let probing: Promise<void> | null = null;

function transition(status: VaultAccessStatus, reason: string | null): void {
  const previous = state.status;
  state.status = status;
  state.reason = reason;
  if (status !== 'pending') {
    const settled = waiters;
    waiters = [];
    for (const waiter of settled) {
      if (status === 'ready') waiter.resolve();
      else waiter.reject(new VaultNotReadyError('the write', reason));
    }
  }
  if (previous === status) return;
  for (const listener of [...listeners]) {
    try {
      listener(status, previous);
    } catch (error) {
      console.error('[vault-access] listener failed', error);
    }
  }
}

/** The vault lock is held and its notes loaded. */
export function markVaultReady(): void {
  transition('ready', null);
}

/** Opening or loading the vault failed; refuse writes until a load succeeds. */
export function markVaultUnavailable(reason: string): void {
  transition('unavailable', reason);
}

/** The vault connection closed. The next write reopens and reloads it first. */
export function markVaultLost(): void {
  if (state.status === 'ready') transition('pending', null);
}

/**
 * How a pending window opens its vault: the tree store registers its
 * `loadTree`, which reports the result here. Kept as a registration so this
 * module, which the API layer imports, never imports the stores.
 */
export function registerVaultAccessProbe(
  load: (() => Promise<void>) | null
): void {
  probe = load;
}

/** Called after each status change, with the status it left. */
export function onVaultAccessChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True when a write may go ahead now. */
export function canWriteStorage(): boolean {
  return state.status === 'ready';
}

/**
 * Refuse `operation` at once in a window whose vault failed to open. For
 * synchronous paths that must not wait, such as an in-memory settings change
 * that would otherwise appear to succeed.
 */
export function assertVaultNotUnavailable(operation: string): void {
  if (state.status === 'unavailable')
    throw new VaultNotReadyError(operation, state.reason);
}

/**
 * Resolve once `operation` may write, or reject with `VaultNotReadyError`.
 * A pending window starts loading its vault if nothing else has.
 */
export async function requireVaultAccess(operation: string): Promise<void> {
  if (state.status === 'ready') return;
  if (state.status === 'unavailable')
    throw new VaultNotReadyError(operation, state.reason);
  if (!probe)
    throw new VaultNotReadyError(operation, 'this window has no vault');
  const settled = new Promise<void>((resolve, reject) =>
    waiters.push({
      resolve,
      reject: (error) =>
        reject(
          error instanceof VaultNotReadyError
            ? new VaultNotReadyError(operation, error.reason)
            : error
        )
    })
  );
  probing ??= probe()
    .catch(() => {
      // The tree store reports its own failure through markVaultUnavailable.
    })
    .finally(() => {
      probing = null;
    });
  return settled;
}

/** Put the gate in a known state. Test-only. */
export function resetVaultAccessForTests(
  status: VaultAccessStatus = 'pending'
): void {
  state.status = status;
  state.reason = null;
  waiters = [];
  probing = null;
}
