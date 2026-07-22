import { invokeOrFallback } from './core';
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
    'set_hotkey_displays',
    { displays },
    () => undefined
  );
}

export function getNativeHotkeyDisplay(
  commandId: string
): Promise<string | null> {
  if (commandId.trim() === '') {
    throw new Error('commandId must not be empty');
  }
  return invokeOrFallback<string | null>(
    'get_hotkey_display',
    { commandId },
    () => null
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
    'sync_global_shortcuts',
    { registrations: nativeRegistrations },
    () => undefined
  );
}
