import { invokeOrFallback } from './index';

export function getCloseToTray(): Promise<boolean> {
  return invokeOrFallback<boolean>('get_close_to_tray', undefined, () => false);
}

export function setCloseToTray(value: boolean): Promise<void> {
  return invokeOrFallback<void>('set_close_to_tray', { value }, () => undefined);
}
