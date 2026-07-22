import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  savePreferences,
  type Preferences
} from './preferences';

const KEY = 'notes-app:preferences:v1';

beforeEach(() => localStorage.clear());

describe('loadPreferences', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('merges stored values over the defaults', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ leftSidebarOpen: false, sortStrategy: 'modified' })
    );
    const prefs = loadPreferences();
    expect(prefs.leftSidebarOpen).toBe(false);
    expect(prefs.sortStrategy).toBe('modified');
    expect(prefs.rightSidebarOpen).toBe(DEFAULT_PREFERENCES.rightSidebarOpen);
  });

  it('clamps sidebar widths into their allowed ranges', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ leftSidebarWidth: 10, rightSidebarWidth: 9999 })
    );
    const prefs = loadPreferences();
    expect(prefs.leftSidebarWidth).toBe(160);
    expect(prefs.rightSidebarWidth).toBe(600);
  });

  it('ignores non-numeric sidebar widths', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        leftSidebarWidth: 'wide',
        rightSidebarWidth: Number.NaN
      })
    );
    const prefs = loadPreferences();
    expect(prefs.leftSidebarWidth).toBe(DEFAULT_PREFERENCES.leftSidebarWidth);
    expect(prefs.rightSidebarWidth).toBe(DEFAULT_PREFERENCES.rightSidebarWidth);
  });

  it('ignores non-boolean sidebar open flags', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ leftSidebarOpen: 'false', rightSidebarOpen: 0 })
    );
    const prefs = loadPreferences();
    expect(prefs.leftSidebarOpen).toBe(DEFAULT_PREFERENCES.leftSidebarOpen);
    expect(prefs.rightSidebarOpen).toBe(DEFAULT_PREFERENCES.rightSidebarOpen);
  });

  it('rejects invalid sort strategy / direction and uses the default', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ sortStrategy: 'bogus', sortDirection: 'sideways' })
    );
    const prefs = loadPreferences();
    expect(prefs.sortStrategy).toBe(DEFAULT_PREFERENCES.sortStrategy);
    expect(prefs.sortDirection).toBe(DEFAULT_PREFERENCES.sortDirection);
  });

  it('falls back to defaults on corrupt JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(KEY, '{not json');
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
    warn.mockRestore();
  });

  it('falls back to defaults when stored JSON is not an object', () => {
    localStorage.setItem(KEY, JSON.stringify(['modified']));
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });
});

describe('savePreferences', () => {
  it('round-trips through localStorage', () => {
    const prefs: Preferences = {
      ...DEFAULT_PREFERENCES,
      leftSidebarWidth: 300,
      sortDirection: 'desc'
    };
    savePreferences(prefs);
    expect(loadPreferences()).toEqual(prefs);
  });
});
