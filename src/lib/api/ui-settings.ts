import {
  assertNumber,
  assertRecord,
  invokeOrFallback,
  TauriCommandName
} from './core';

export interface UiSettingsSnapshot {
  deviceRevision: number;
  vaultRevision: number;
  values: Record<string, unknown>;
}

function parseSnapshot(value: unknown): UiSettingsSnapshot {
  const record = assertRecord(value, 'UI settings snapshot');
  return {
    deviceRevision: assertNumber(record.deviceRevision, 'device revision'),
    vaultRevision: assertNumber(record.vaultRevision, 'vault revision'),
    values: assertRecord(record.values, 'UI settings values')
  };
}

function nativeOnly(): never {
  throw new Error('UI settings documents require native storage');
}

export function initializeUiSettings(
  expectedVaultId: string,
  deviceRaw: string | null,
  vaultRaw: string | null,
  preferencesRaw: string | null,
  layoutRaw: string | null
): Promise<UiSettingsSnapshot> {
  return invokeOrFallback(
    TauriCommandName.InitializeUiSettings,
    { expectedVaultId, deviceRaw, vaultRaw, preferencesRaw, layoutRaw },
    nativeOnly,
    parseSnapshot
  );
}

export function loadUiSettings(
  expectedVaultId: string
): Promise<UiSettingsSnapshot> {
  return invokeOrFallback(
    TauriCommandName.LoadUiSettings,
    { expectedVaultId },
    nativeOnly,
    parseSnapshot
  );
}

export function patchUiSetting(
  expectedVaultId: string,
  id: string,
  value: unknown,
  remove = false
): Promise<UiSettingsSnapshot> {
  return invokeOrFallback(
    TauriCommandName.PatchUiSetting,
    { expectedVaultId, id, value: remove ? null : value, remove },
    nativeOnly,
    parseSnapshot
  );
}
