import { beforeEach } from 'vitest';
import { resetAppStorageForTests } from '../../src/lib/storage/app-storage';
import { resetVaultAccessForTests } from '../../src/lib/storage/vault-access.svelte';

// Unit tests exercise stores and API wrappers without opening a vault, so
// they start with the storage gate open. Tests of the gate reset it to
// `pending` themselves.
beforeEach(() => {
  resetAppStorageForTests();
  resetVaultAccessForTests('ready');
});
