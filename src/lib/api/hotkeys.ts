import {
  assertString,
  assertRecord,
  assertBoolean,
  assertVoid,
  TauriCommandName,
  invokeOrFallback
} from './core';
import {
  nativeGlobalShortcutCommandId,
  type NativeGlobalShortcutCommandId
} from '$lib/hotkeys/catalogue';

export interface NativeHotkeyDisplay {
  commandId: string;
  display: string | null;
  accelerator: string | null;
}

export interface NativeGlobalShortcutRegistration {
  commandId: NativeGlobalShortcutCommandId;
  accelerator: string | null;
}

export interface GlobalShortcutRegistrationInput {
  commandId: string;
  accelerator: string | null;
}

export function setNativeHotkeyDisplays(
  displays: NativeHotkeyDisplay[]
): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.SetHotkeyDisplays,
    { displays },
    () => undefined,
    (value) => assertVoid(value, 'set_hotkey_displays response')
  );
}

export function getNativeHotkeyDisplay(
  commandId: string
): Promise<string | null> {
  if (commandId.trim() === '') {
    throw new Error('commandId must not be empty');
  }
  return invokeOrFallback<string | null>(
    TauriCommandName.GetHotkeyDisplay,
    { commandId },
    () => null,
    parseOptionalString
  );
}

export function syncNativeGlobalShortcuts(
  registrations: GlobalShortcutRegistrationInput[]
): Promise<void> {
  const nativeRegistrations: NativeGlobalShortcutRegistration[] =
    registrations.map((registration) => {
      if (
        registration.accelerator !== null &&
        registration.accelerator.trim() === ''
      ) {
        throw new Error('accelerator must be null or a non-empty string');
      }
      return {
        commandId: nativeGlobalShortcutCommandId(registration.commandId),
        accelerator: registration.accelerator
      };
    });
  return invokeOrFallback<void>(
    TauriCommandName.SyncGlobalShortcuts,
    { registrations: nativeRegistrations },
    () => undefined,
    (value) => assertVoid(value, 'sync_global_shortcuts response')
  );
}

function parseOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return assertString(value, 'get_hotkey_display response');
}

export interface GlobalShortcutStatus {
  coordinated: boolean;
  settling: boolean;
  registered: { commandId: string; accelerator: string }[];
  error: string | null;
}

export function getGlobalShortcutStatus(): Promise<GlobalShortcutStatus> {
  return invokeOrFallback(
    TauriCommandName.GetGlobalShortcutStatus,
    {},
    () => ({
      coordinated: false,
      settling: false,
      registered: [],
      error: null
    }),
    (value) => {
      const record = assertRecord(value, 'global shortcut status');
      if (!Array.isArray(record.registered))
        throw new Error('invalid shortcut registrations');
      return {
        coordinated: assertBoolean(record.coordinated, 'coordinated'),
        settling: assertBoolean(record.settling, 'settling'),
        registered: record.registered.map((entry) => {
          const binding = assertRecord(entry, 'shortcut registration');
          return {
            commandId: assertString(binding.commandId, 'commandId'),
            accelerator: assertString(binding.accelerator, 'accelerator')
          };
        }),
        error: parseOptionalString(record.error)
      };
    }
  );
}
