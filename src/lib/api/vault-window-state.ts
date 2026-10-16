import { isMobile } from '$lib/platform';
import {
  assertBoolean,
  assertRecord,
  assertString,
  invokeOrFallback,
  TauriCommandName
} from './core';

export enum VaultWindowStatus {
  Starting = 'starting',
  Ready = 'ready',
  Unavailable = 'unavailable'
}

export interface VaultWindowState {
  supervised: boolean;
  vaults: { vaultId: string; status: VaultWindowStatus }[];
}

export function parseVaultWindowState(value: unknown): VaultWindowState {
  const view = assertRecord(value, 'vault window state');
  const supervised = assertBoolean(view.supervised, 'supervised runtime');
  if (!Array.isArray(view.vaults))
    throw new Error('vault window states must be an array');
  const ids = new Set<string>();
  const vaults = view.vaults.map((value) => {
    const entry = assertRecord(value, 'vault window entry');
    const vaultId = assertString(entry.vaultId, 'vault id');
    const status = assertString(entry.status, 'vault window status');
    if (!vaultId || ids.has(vaultId))
      throw new Error('vault window ids must be unique and nonempty');
    ids.add(vaultId);
    if (!Object.values(VaultWindowStatus).includes(status as VaultWindowStatus))
      throw new Error('unknown vault window status');
    return { vaultId, status: status as VaultWindowStatus };
  });
  if (!supervised && vaults.length)
    throw new Error('direct runtime cannot report supervised workers');
  return { supervised, vaults };
}

/** Observations are hints for the menu. The opening command rechecks ownership. */
export function getVaultWindowState(): Promise<VaultWindowState> {
  if (isMobile()) return Promise.resolve({ supervised: false, vaults: [] });
  return invokeOrFallback(
    TauriCommandName.GetVaultWindowState,
    undefined,
    () => ({ supervised: false, vaults: [] }),
    parseVaultWindowState
  );
}
