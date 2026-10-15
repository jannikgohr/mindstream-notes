/**
 * Showing the devices signed in to an account.
 *
 * The server stores what each device called itself when it signed in, which
 * is the client's user agent. This app sends a readable one, followed by the
 * client library's own name and version. Other clients send whatever they
 * send.
 */

import type { DeviceSession } from '$lib/api/account';

/** The client library's tag at the end of this app's user agent. */
const LIBRARY_SUFFIX = /\s+etebase\/[\w.+-]+$/;

/** A device's name without the library tag. Empty when the device sent no
 *  name at all, which the caller shows as "Unknown device". */
export function deviceLabel(deviceName: string): string {
  return deviceName.replace(LIBRARY_SUFFIX, '').trim();
}

/** This device first, then the most recently used. */
export function orderDevices(devices: DeviceSession[]): DeviceSession[] {
  return [...devices].sort(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      b.lastUsedAt - a.lastUsedAt ||
      b.id - a.id
  );
}

/** A server timestamp, in seconds, as a date and time in `language`. */
export function formatDeviceTime(seconds: number, language: string): string {
  const date = new Date(seconds * 1000);
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'short'
  };
  try {
    return new Intl.DateTimeFormat(language, options).format(date);
  } catch {
    // A language tag the runtime does not know.
    return new Intl.DateTimeFormat(undefined, options).format(date);
  }
}
