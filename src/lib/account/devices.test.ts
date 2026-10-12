import { describe, expect, it } from 'vitest';
import type { DeviceSession } from '$lib/api/account';
import { deviceLabel, formatDeviceTime, orderDevices } from './devices';

function device(over: Partial<DeviceSession>): DeviceSession {
  return {
    id: 1,
    deviceName: 'A device',
    createdAt: 1_790_000_000,
    lastUsedAt: 1_790_000_000,
    secondFactor: false,
    current: false,
    ...over
  };
}

describe('deviceLabel', () => {
  it('drops the tag of the client library from the name', () => {
    expect(
      deviceLabel('Mindstream Notes on LAPTOP-7 (Windows) etebase/0.6.1')
    ).toBe('Mindstream Notes on LAPTOP-7 (Windows)');
  });

  it('leaves the name of any other client as it is', () => {
    expect(deviceLabel('curl/8.4.0')).toBe('curl/8.4.0');
    expect(deviceLabel('etebase/0.6.1 something')).toBe(
      'etebase/0.6.1 something'
    );
  });

  it('is empty for a device that sent no name', () => {
    expect(deviceLabel('')).toBe('');
    expect(deviceLabel('   ')).toBe('');
  });
});

describe('orderDevices', () => {
  it('puts this device first, then the most recently used', () => {
    const ordered = orderDevices([
      device({ id: 1, lastUsedAt: 300 }),
      device({ id: 2, lastUsedAt: 100, current: true }),
      device({ id: 3, lastUsedAt: 500 }),
      device({ id: 4, lastUsedAt: 300 })
    ]);
    expect(ordered.map((d) => d.id)).toEqual([2, 3, 4, 1]);
  });

  it('leaves the list it was given alone', () => {
    const given = [device({ id: 1 }), device({ id: 2, current: true })];
    orderDevices(given);
    expect(given.map((d) => d.id)).toEqual([1, 2]);
  });
});

describe('formatDeviceTime', () => {
  it('writes the time in the language asked for', () => {
    // Midday UTC, so the month is the same in every time zone.
    const seconds = Date.UTC(2026, 9, 12, 12, 0) / 1000;
    expect(formatDeviceTime(seconds, 'en')).toMatch(/Oct \d+, 2026/);
    expect(formatDeviceTime(seconds, 'de')).toMatch(/\d+\.10\.2026/);
  });

  it('falls back to the system language for a tag it cannot use', () => {
    expect(formatDeviceTime(1_790_000_000, 'not a language')).not.toBe('');
  });
});
