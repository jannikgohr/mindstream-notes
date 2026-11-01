import { browserStorageEnabled } from './commands';
import { isTestVaultId, vaultNamespace } from './namespace';

export function browserTestVaultId(): string | undefined {
  if (
    typeof window === 'undefined' ||
    '__TAURI_INTERNALS__' in window ||
    !browserStorageEnabled()
  )
    return undefined;
  const id = import.meta.env.VITE_BROWSER_TEST_VAULT;
  if (id === undefined || id === '') return undefined;
  if (!isTestVaultId(id))
    throw new Error('Invalid browser test vault identifier');
  return id;
}

export function browserRecoveryNamespace() {
  return vaultNamespace(browserTestVaultId());
}
