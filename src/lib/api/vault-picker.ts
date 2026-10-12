import {
  assertBoolean,
  assertRecord,
  assertString,
  assertVoid,
  invokeOrFallback,
  TauriCommandName
} from './core';

export interface PickerVault {
  id: string;
  name: string;
  available: boolean;
}

export function getPickerVaults(): Promise<PickerVault[]> {
  return invokeOrFallback(
    TauriCommandName.GetPickerVaults,
    undefined,
    () => [],
    (value) => {
      if (!Array.isArray(value))
        throw new Error('Picker vaults must be an array');
      return value.map((entry) => {
        const raw = assertRecord(entry, 'picker vault');
        return {
          id: assertString(raw.id, 'vault id'),
          name: assertString(raw.name, 'vault name'),
          available: assertBoolean(raw.available, 'vault availability')
        };
      });
    }
  );
}

export function openPickerVault(id: string): Promise<void> {
  return invokeOrFallback(
    TauriCommandName.OpenPickerVault,
    { id },
    () => {
      throw new Error('Vault selection requires the desktop runtime');
    },
    (value) => assertVoid(value, 'picker opening')
  );
}
