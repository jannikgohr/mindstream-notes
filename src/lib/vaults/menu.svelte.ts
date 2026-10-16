import { openProfileWindow } from '$lib/api/profiles';
import {
  getVaultWindowState,
  type VaultWindowState
} from '$lib/api/vault-window-state';

export type VaultOpenMode = 'thisWindow' | 'newWindow';
export type VaultOpeningPreference = 'ask' | VaultOpenMode;

/** Menu observations never authorize ownership or a fallback to direct mode. */
export class VaultMenu {
  view = $state<VaultWindowState | null>(null);
  /** A check is in flight and nothing current has been observed yet. */
  checking = $state(false);
  failed = $state(false);
  #observationId = 0;
  #current = false;

  invalidate() {
    ++this.#observationId;
    this.#current = false;
    this.checking = false;
  }

  async refresh() {
    const id = ++this.#observationId;
    // Re-observing a current view is a background poll. It must not block the
    // menu: toggling `checking` every few seconds made its controls flicker.
    this.checking = !this.#current;
    this.failed = false;
    try {
      const view = await getVaultWindowState();
      if (id !== this.#observationId) return false;
      this.view = view;
      this.#current = true;
      return true;
    } catch {
      if (id !== this.#observationId) return false;
      this.view = null;
      this.#current = false;
      this.failed = true;
      return false;
    } finally {
      if (id === this.#observationId) this.checking = false;
    }
  }

  status(id: string) {
    return this.view?.vaults.find((entry) => entry.vaultId === id)?.status;
  }

  canDelete(id: string) {
    return this.view !== null && !this.checking && !this.status(id);
  }

  /** False means explicit direct mode; errors never select the restart flow. */
  decision(
    id: string,
    preference: unknown,
    forceNewWindow = false
  ): VaultOpeningPreference {
    if (forceNewWindow || this.status(id)) return 'newWindow';
    return preference === 'thisWindow' || preference === 'newWindow'
      ? preference
      : 'ask';
  }

  async open(id: string, mode: VaultOpenMode = 'newWindow') {
    if (this.checking || !this.view)
      throw new Error('Vault window state is unavailable');
    if (!this.view.supervised) return false;
    if (mode === 'thisWindow') await openProfileWindow(id, true);
    else await openProfileWindow(id);
    return true;
  }
}
