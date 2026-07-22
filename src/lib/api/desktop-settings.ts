import {
  assertBoolean,
  assertString,
  assertVoid,
  TauriCommandName,
  invokeOrFallback
} from './core';

export enum DesktopThemeMode {
  Light = 'light',
  Dark = 'dark',
  System = 'system'
}

export function isDesktopThemeMode(value: unknown): value is DesktopThemeMode {
  return (
    typeof value === 'string' &&
    (Object.values(DesktopThemeMode) as string[]).includes(value)
  );
}

function parseDesktopThemeMode(value: unknown): DesktopThemeMode {
  if (!isDesktopThemeMode(value)) {
    throw new Error('desktop theme mode must be light, dark, or system');
  }
  return value;
}

export function getCloseToTray(): Promise<boolean> {
  return invokeOrFallback<boolean>(
    TauriCommandName.GetCloseToTray,
    undefined,
    () => false,
    (value) => assertBoolean(value, 'get_close_to_tray')
  );
}

export function setCloseToTray(value: boolean): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.SetCloseToTray,
    { value },
    () => undefined,
    (response) => assertVoid(response, 'set_close_to_tray response')
  );
}

export function getStartInTray(): Promise<boolean> {
  return invokeOrFallback<boolean>(
    TauriCommandName.GetStartInTray,
    undefined,
    () => false,
    (value) => assertBoolean(value, 'get_start_in_tray')
  );
}

export function setStartInTray(value: boolean): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.SetStartInTray,
    { value },
    () => undefined,
    (response) => assertVoid(response, 'set_start_in_tray response')
  );
}

export function getCustomWindowDecorations(): Promise<boolean> {
  return invokeOrFallback<boolean>(
    TauriCommandName.GetCustomWindowDecorations,
    undefined,
    () =>
      typeof navigator === 'undefined' ||
      !/mac os x|macintosh/i.test(navigator.userAgent),
    (value) => assertBoolean(value, 'get_custom_window_decorations')
  );
}

export function setCustomWindowDecorations(value: boolean): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.SetCustomWindowDecorations,
    { value },
    () => undefined,
    (response) => assertVoid(response, 'set_custom_window_decorations response')
  );
}

export function getDesktopLanguage(): Promise<string> {
  return invokeOrFallback<string>(
    TauriCommandName.GetDesktopLanguage,
    undefined,
    () => 'en',
    (value) => assertString(value, 'get_desktop_language')
  );
}

export function setDesktopLanguage(code: string): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.SetDesktopLanguage,
    { code },
    () => undefined,
    (response) => assertVoid(response, 'set_desktop_language response')
  );
}

export function getDesktopThemeMode(): Promise<DesktopThemeMode> {
  return invokeOrFallback<DesktopThemeMode>(
    TauriCommandName.GetDesktopThemeMode,
    undefined,
    () =>
      parseDesktopThemeMode(
        typeof localStorage === 'undefined'
          ? DesktopThemeMode.System
          : (localStorage.getItem('mode-watcher-mode') ??
              DesktopThemeMode.System)
      ),
    parseDesktopThemeMode
  );
}

export function setDesktopThemeMode(mode: DesktopThemeMode): Promise<void> {
  parseDesktopThemeMode(mode);
  return invokeOrFallback<void>(
    TauriCommandName.SetDesktopThemeMode,
    { mode },
    () => undefined,
    (response) => assertVoid(response, 'set_desktop_theme_mode response')
  );
}
