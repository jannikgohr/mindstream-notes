import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AVAILABLE_LANGUAGES,
  i18n,
  setLanguage,
  tDescription,
  tLabel,
  tUi,
  tValue
} from './i18n.svelte';

afterEach(() => setLanguage('en'));

describe('AVAILABLE_LANGUAGES', () => {
  it('includes the bundled english and german packs', () => {
    expect(AVAILABLE_LANGUAGES).toContain('en');
    expect(AVAILABLE_LANGUAGES).toContain('de');
  });
});

describe('setLanguage', () => {
  it('switches to a known language', () => {
    setLanguage('de');
    expect(i18n.language).toBe('de');
    expect(i18n.bundle.language).toBeTruthy();
  });

  it('falls back to english for an unknown code', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setLanguage('xx');
    expect(i18n.language).toBe('en');
    warn.mockRestore();
  });
});

describe('lookups', () => {
  it('tLabel falls back to the id when the key is unknown', () => {
    expect(tLabel('settings', 'totally.unknown.id')).toBe('totally.unknown.id');
  });

  it('tValue falls back to the raw value when unknown', () => {
    expect(tValue('some.setting', 'rawValue')).toBe('rawValue');
  });

  it('tUi falls back to the key when unknown', () => {
    expect(tUi('nonexistent.ui.key' as never)).toBe('nonexistent.ui.key');
  });

  it('tDescription is undefined for an unknown id', () => {
    expect(tDescription('categories', 'no.such.category')).toBeUndefined();
  });
});
