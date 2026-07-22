import { assertBoolean, assertString, invokeOrFallback } from './core';

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
    'get_close_to_tray',
    undefined,
    () => false,
    (value) => assertBoolean(value, 'get_close_to_tray')
  );
}

export function setCloseToTray(value: boolean): Promise<void> {
  return invokeOrFallback<void>(
    'set_close_to_tray',
    { value },
    () => undefined
  );
}

export function getStartInTray(): Promise<boolean> {
  return invokeOrFallback<boolean>(
    'get_start_in_tray',
    undefined,
    () => false,
    (value) => assertBoolean(value, 'get_start_in_tray')
  );
}

export function setStartInTray(value: boolean): Promise<void> {
  return invokeOrFallback<void>(
    'set_start_in_tray',
    { value },
    () => undefined
  );
}

export function getCustomWindowDecorations(): Promise<boolean> {
  return invokeOrFallback<boolean>(
    'get_custom_window_decorations',
    undefined,
    () =>
      typeof navigator === 'undefined' ||
      !/mac os x|macintosh/i.test(navigator.userAgent),
    (value) => assertBoolean(value, 'get_custom_window_decorations')
  );
}

export function setCustomWindowDecorations(value: boolean): Promise<void> {
  return invokeOrFallback<void>(
    'set_custom_window_decorations',
    { value },
    () => undefined
  );
}

export function getDesktopLanguage(): Promise<string> {
  return invokeOrFallback<string>(
    'get_desktop_language',
    undefined,
    () => 'en',
    (value) => assertString(value, 'get_desktop_language')
  );
}

export function setDesktopLanguage(code: string): Promise<void> {
  return invokeOrFallback<void>(
    'set_desktop_language',
    { code },
    () => undefined
  );
}

export function getDesktopThemeMode(): Promise<DesktopThemeMode> {
  return invokeOrFallback<DesktopThemeMode>(
    'get_desktop_theme_mode',
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
    'set_desktop_theme_mode',
    { mode },
    () => undefined
  );
}
