import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AVAILABLE_LANGUAGES,
  i18n,
  setLanguage,
  tDescription,
  tLabel,
  tUi,
  tUiFormat,
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

describe('tUiFormat', () => {
  it('fills every placeholder from the vars', () => {
    expect(tUiFormat('fileTree.menu.batch.delete', { count: 3 })).toBe(
      'Delete 3 items'
    );
    expect(tUiFormat('mobile.moveTo.target', { name: 'Work' })).toBe(
      'Move to Work'
    );
  });

  it('uses the active language', () => {
    setLanguage('de');
    expect(tUiFormat('fileTree.menu.batch.delete', { count: 3 })).toBe(
      '3 Elemente löschen'
    );
  });

  // The values are user text. A plain-string replacement would expand
  // these patterns instead of inserting them.
  it('inserts replacement patterns in a value literally', () => {
    expect(tUiFormat('mobile.moveTo.target', { name: 'Costs $& $1 $$' })).toBe(
      'Move to Costs $& $1 $$'
    );
  });

  it('leaves a placeholder with no matching var as written', () => {
    expect(tUiFormat('mobile.moveTo.target', {})).toBe('Move to {name}');
  });

  it('falls back to the key when it is unknown', () => {
    expect(tUiFormat('nonexistent.ui.key' as never, { count: 1 })).toBe(
      'nonexistent.ui.key'
    );
  });
});
