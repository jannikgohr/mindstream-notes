import {
  assertBoolean,
  assertRecord,
  assertString,
  assertVoid,
  invokeOrFallback,
  TauriCommandName
} from './core';
import { DesktopThemeMode, isDesktopThemeMode } from './desktop-settings';

export interface PickerVault {
  id: string;
  name: string;
  available: boolean;
  /** The tile's named colour from profiles.json (NAMED_COLORS). */
  color?: string;
}

export interface VaultPickerState {
  vaults: PickerVault[];
  languageCode: string;
  themeMode: DesktopThemeMode;
}

export function getVaultPickerState(): Promise<VaultPickerState> {
  return invokeOrFallback(
    TauriCommandName.GetPickerVaults,
    undefined,
    () => ({
      vaults: [],
      languageCode: 'en',
      themeMode: DesktopThemeMode.System
    }),
    (value) => {
      const state = assertRecord(value, 'vault picker state');
      if (!Array.isArray(state.vaults))
        throw new Error('Picker vaults must be an array');
      if (!isDesktopThemeMode(state.themeMode))
        throw new Error('Picker theme mode must be light, dark, or system');
      const vaults = state.vaults.map((entry) => {
        const raw = assertRecord(entry, 'picker vault');
        return {
          id: assertString(raw.id, 'vault id'),
          name: assertString(raw.name, 'vault name'),
          available: assertBoolean(raw.available, 'vault availability'),
          ...(raw.color == null
            ? {}
            : { color: assertString(raw.color, 'vault color') })
        };
      });
      return {
        vaults,
        languageCode: assertString(state.languageCode, 'picker language'),
        themeMode: state.themeMode
      };
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
