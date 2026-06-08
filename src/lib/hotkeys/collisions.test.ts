/**
 * Tests for the OS-collision detector.
 *
 * Each test pins `navigator.platform` so the platform-gated entries
 * resolve deterministically — otherwise the result would depend on
 * which OS happens to run the CI host.
 */
import { describe, expect, it } from 'vitest';
import {
  _knownConflictsForCurrentPlatform,
  parseBinding,
  wellKnownConflict
} from './collisions';

function forceMac() {
  Object.defineProperty(navigator, 'platform', {
    value: 'MacIntel',
    configurable: true
  });
}

function forceWindows() {
  Object.defineProperty(navigator, 'platform', {
    value: 'Win32',
    configurable: true
  });
}

describe('wellKnownConflict', () => {
  it('returns null for null / empty input', () => {
    expect(wellKnownConflict(null)).toBeNull();
    expect(wellKnownConflict('')).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(wellKnownConflict('garbage')).toBeNull();
  });

  it('returns null for safe bindings (Mac)', () => {
    forceMac();
    expect(wellKnownConflict('mod+b')).toBeNull();
    expect(wellKnownConflict('mod+shift+8')).toBeNull();
  });

  it('returns null for safe bindings (non-Mac)', () => {
    forceWindows();
    expect(wellKnownConflict('mod+b')).toBeNull();
    expect(wellKnownConflict('mod+shift+8')).toBeNull();
  });

  it('warns about Cmd+Q on Mac but not on Windows', () => {
    forceMac();
    expect(wellKnownConflict('mod+q')).toMatch(/quit/i);
    forceWindows();
    // Ctrl+Q on Windows isn't a system reservation — should be silent.
    expect(wellKnownConflict('mod+q')).toBeNull();
  });

  it('warns about Cmd+Space (Spotlight) only on Mac', () => {
    forceMac();
    expect(wellKnownConflict('mod+space')).toMatch(/spotlight/i);
    forceWindows();
    expect(wellKnownConflict('mod+space')).toBeNull();
  });

  it('warns about Alt+Tab on non-Mac but not on Mac', () => {
    forceWindows();
    expect(wellKnownConflict('alt+tab')).toMatch(/switch/i);
    forceMac();
    expect(wellKnownConflict('alt+tab')).toBeNull();
  });

  it('warns about Alt+F4 on Windows / Linux', () => {
    forceWindows();
    expect(wellKnownConflict('alt+f4')).toMatch(/close/i);
  });

  it('matches regardless of modifier order in the input', () => {
    forceMac();
    expect(wellKnownConflict('Shift+Mod+3')).toMatch(/screenshot/i);
  });
});

describe('seed list invariants', () => {
  it('every seed entry parses', () => {
    // If the seed list ever ships an unparseable binding it would
    // silently never match anything — catch it at PR review.
    const invalid: string[] = [];
    for (const entry of _knownConflictsForCurrentPlatform()) {
      if (parseBinding(entry.binding) === null) invalid.push(entry.binding);
    }
    expect(invalid).toEqual([]);
  });
});
