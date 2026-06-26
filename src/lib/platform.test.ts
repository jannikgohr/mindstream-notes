import { afterEach, describe, expect, it } from 'vitest';
import {
  getPlatform,
  isAndroid,
  isMobile,
  matchesPlatformFilter
} from './platform';

const UAS = {
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
  macos: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 Chrome/120 Mobile',
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
  unknown: 'Some/1.0 RandomAgent'
};

function setUA(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', {
    value: ua,
    configurable: true
  });
}

afterEach(() => setUA(UAS.windows));

describe('getPlatform', () => {
  it('maps each known user agent', () => {
    setUA(UAS.windows);
    expect(getPlatform()).toBe('windows');
    setUA(UAS.macos);
    expect(getPlatform()).toBe('macos');
    setUA(UAS.linux);
    expect(getPlatform()).toBe('linux');
    setUA(UAS.android);
    expect(getPlatform()).toBe('android');
    setUA(UAS.ios);
    expect(getPlatform()).toBe('ios');
  });

  it('prefers android over the parent Linux string in the UA', () => {
    setUA(UAS.android);
    expect(getPlatform()).toBe('android');
  });

  it('returns null for an unrecognised UA', () => {
    setUA(UAS.unknown);
    expect(getPlatform()).toBeNull();
  });
});

describe('isMobile / isAndroid', () => {
  it('detects mobile UAs', () => {
    setUA(UAS.android);
    expect(isMobile()).toBe(true);
    expect(isAndroid()).toBe(true);
    setUA(UAS.ios);
    expect(isMobile()).toBe(true);
    expect(isAndroid()).toBe(false);
  });

  it('is false on desktop', () => {
    setUA(UAS.windows);
    expect(isMobile()).toBe(false);
    expect(isAndroid()).toBe(false);
  });
});

describe('matchesPlatformFilter', () => {
  it('returns true for empty / missing filters', () => {
    expect(matchesPlatformFilter(undefined)).toBe(true);
    expect(matchesPlatformFilter(null)).toBe(true);
    expect(matchesPlatformFilter([])).toBe(true);
  });

  it('matches a specific OS name', () => {
    setUA(UAS.macos);
    expect(matchesPlatformFilter(['macos'])).toBe(true);
    expect(matchesPlatformFilter(['windows'])).toBe(false);
  });

  it('matches the desktop group for desktop OSes', () => {
    setUA(UAS.linux);
    expect(matchesPlatformFilter(['desktop'])).toBe(true);
    expect(matchesPlatformFilter(['mobile'])).toBe(false);
  });

  it('matches the mobile group for mobile OSes', () => {
    setUA(UAS.android);
    expect(matchesPlatformFilter(['mobile'])).toBe(true);
    expect(matchesPlatformFilter(['desktop'])).toBe(false);
  });

  it('accepts a mix of OS names and groups', () => {
    setUA(UAS.ios);
    expect(matchesPlatformFilter(['windows', 'mobile'])).toBe(true);
  });

  it('returns true for an unknown platform so nothing silently hides', () => {
    setUA(UAS.unknown);
    expect(matchesPlatformFilter(['windows'])).toBe(true);
  });
});
