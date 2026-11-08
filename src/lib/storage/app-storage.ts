/**
 * localStorage for the app's own state, behind the vault access gate.
 *
 * Browser tabs share localStorage, so a tab that could not open the vault
 * must not write there: its settings, layout and preferences are a snapshot
 * of state it does not own, and saving them overwrites the tab that does.
 * Every app write goes through here instead of `localStorage` directly; an
 * ESLint rule keeps it that way.
 *
 *   - ready: written at once.
 *   - pending: held, latest value per key, and written once the vault is
 *     ready. Reads through `readAppStorage` see the held value.
 *   - unavailable: dropped. Held values are dropped too.
 *   - pending after a lost connection: held, then dropped once the vault is
 *     ready again. The worker that held the lock stopped, another tab may
 *     have taken the vault in between, and what this tab held is a snapshot
 *     from before that. Stores read their state again once it is ready.
 *
 * Tab-local `sessionStorage` and the draft recovery store, which has to keep
 * typing safe exactly when the vault is gone, write directly by design.
 */

import {
  canWriteStorage,
  onVaultAccessChange,
  requireVaultAccess,
  vaultAccess
} from './vault-access.svelte';

/** Key → value to write, or `null` to remove. */
const held = new Map<string, string | null>();

function apply(key: string, value: string | null): void {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

function flush(): void {
  const entries = [...held];
  held.clear();
  for (const [key, value] of entries) {
    try {
      apply(key, value);
    } catch (error) {
      console.warn('[app-storage] deferred write failed for', key, error);
    }
  }
}

/** The vault connection was lost since this window last had it ready. */
let lost = false;

onVaultAccessChange((status, previous) => {
  if (status === 'pending' && previous === 'ready') lost = true;
  if (status === 'ready') {
    if (lost) held.clear();
    else flush();
    lost = false;
  } else if (status === 'unavailable') {
    held.clear();
  }
});

function write(key: string, value: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (canWriteStorage()) {
    apply(key, value);
    return;
  }
  if (vaultAccess.status === 'unavailable') {
    console.warn(
      `[app-storage] not saving ${key}: the vault is not open in this window`
    );
    return;
  }
  held.set(key, value);
  // Opens the vault if nothing else is. Failure is reported by the gate.
  requireVaultAccess(`saving ${key}`).catch(() => {});
}

/** The stored value, including one still waiting for the vault. */
export function readAppStorage(key: string): string | null {
  if (held.has(key)) return held.get(key) ?? null;
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(key);
}

export function writeAppStorage(key: string, value: string): void {
  write(key, value);
}

export function removeAppStorage(key: string): void {
  write(key, null);
}

/** Drop held writes. Test-only. */
export function resetAppStorageForTests(): void {
  held.clear();
  lost = false;
}
