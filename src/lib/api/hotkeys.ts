import { invokeOrFallback } from './index';

export interface NativeHotkeyDisplay {
  commandId: string;
  display: string | null;
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
  return invokeOrFallback<string | null>(
    'get_hotkey_display',
    { commandId },
    () => null
  );
}
