import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMac } from './platform';

const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function stubNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    value,
    configurable: true
  });
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'navigator', original);
  vi.restoreAllMocks();
});

describe('isMac', () => {
  it('detects a Mac from navigator.platform', () => {
    stubNavigator({ platform: 'MacIntel', userAgent: '' });
    expect(isMac()).toBe(true);
  });

  it('detects iOS devices from platform', () => {
    stubNavigator({ platform: 'iPhone', userAgent: '' });
    expect(isMac()).toBe(true);
  });

  it('returns false for Windows', () => {
    stubNavigator({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT)' });
    expect(isMac()).toBe(false);
  });

  it('falls back to userAgent when platform is empty', () => {
    stubNavigator({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh)' });
    expect(isMac()).toBe(true);
  });

  it('is false when navigator is undefined (SSR-safe)', () => {
    stubNavigator(undefined);
    expect(isMac()).toBe(false);
  });
});
