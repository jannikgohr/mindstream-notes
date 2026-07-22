import {
  assertString,
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
