import { invokeOrFallback } from './index';

export function getCloseToTray(): Promise<boolean> {
  return invokeOrFallback<boolean>('get_close_to_tray', undefined, () => false);
}

export function setCloseToTray(value: boolean): Promise<void> {
  return invokeOrFallback<void>('set_close_to_tray', { value }, () => undefined);
}

export function getStartInTray(): Promise<boolean> {
  return invokeOrFallback<boolean>('get_start_in_tray', undefined, () => false);
}

export function setStartInTray(value: boolean): Promise<void> {
  return invokeOrFallback<void>('set_start_in_tray', { value }, () => undefined);
}

export function getDesktopLanguage(): Promise<string> {
  return invokeOrFallback<string>('get_desktop_language', undefined, () => 'en');
}

export function setDesktopLanguage(code: string): Promise<void> {
  return invokeOrFallback<void>('set_desktop_language', { code }, () => undefined);
}
