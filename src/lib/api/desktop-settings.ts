import { invokeOrFallback } from './core';

export function getCloseToTray(): Promise<boolean> {
  return invokeOrFallback<boolean>('get_close_to_tray', undefined, () => false);
}

export function setCloseToTray(value: boolean): Promise<void> {
  return invokeOrFallback<void>(
    'set_close_to_tray',
    { value },
    () => undefined
  );
}

export function getStartInTray(): Promise<boolean> {
  return invokeOrFallback<boolean>('get_start_in_tray', undefined, () => false);
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
      !/mac os x|macintosh/i.test(navigator.userAgent)
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
    () => 'en'
  );
}

export function setDesktopLanguage(code: string): Promise<void> {
  return invokeOrFallback<void>(
    'set_desktop_language',
    { code },
    () => undefined
  );
}

export function getDesktopThemeMode(): Promise<'light' | 'dark' | 'system'> {
  return invokeOrFallback<'light' | 'dark' | 'system'>(
    'get_desktop_theme_mode',
    undefined,
    () =>
      (typeof localStorage === 'undefined'
        ? 'system'
        : (localStorage.getItem('mode-watcher-mode') ?? 'system')) as
        | 'light'
        | 'dark'
        | 'system'
  );
}

export function setDesktopThemeMode(
  mode: 'light' | 'dark' | 'system'
): Promise<void> {
  return invokeOrFallback<void>(
    'set_desktop_theme_mode',
    { mode },
    () => undefined
  );
}
