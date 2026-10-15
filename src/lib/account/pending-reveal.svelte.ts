/**
 * A recovery key that has been issued and not yet acknowledged.
 *
 * Signing up and recovering both end with a key the user must store, and
 * with a session the Rust side has already saved. The window is reloaded
 * only once the user says the key is stored. Until then the key lives here,
 * outside any component, so closing the settings dialog by accident does not
 * throw away the only copy: opening it again shows the key again.
 */

import type { NewAccount } from '$lib/api/account';

class PendingReveal {
  current = $state<NewAccount | null>(null);
}

export const pendingReveal = new PendingReveal();
