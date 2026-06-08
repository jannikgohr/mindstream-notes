/**
 * Parse / format / conflict tests.
 *
 * Negative-space programming: the parser is the single chokepoint that
 * decides what a *valid* binding looks like. Each rule documented at
 * the top of `parse.ts` gets a test that exercises both the accept and
 * the reject path — if a future change loosens a rule by accident,
 * something here breaks.
 */

import { describe, expect, it } from 'vitest';
import {
  bindingsConflict,
  canonicalize,
  formatChord,
  parseBinding
} from './parse';

describe('parseBinding', () => {
  it('returns null for empty / whitespace input', () => {
    expect(parseBinding('')).toBeNull();
    expect(parseBinding('   ')).toBeNull();
    expect(parseBinding('\t\n')).toBeNull();
  });

  it('parses single-modifier bindings', () => {
    expect(parseBinding('mod+b')).toEqual({
      mod: true,
      ctrl: false,
      alt: false,
      shift: false,
      key: 'b'
    });
  });

  it('is case-insensitive', () => {
    expect(parseBinding('Mod+B')).toEqual(parseBinding('mod+b'));
    expect(parseBinding('CTRL+SHIFT+Z')).toEqual(parseBinding('ctrl+shift+z'));
  });

  it('treats duplicate modifiers as idempotent', () => {
    const a = parseBinding('mod+mod+b');
    const b = parseBinding('mod+b');
    expect(a).toEqual(b);
  });

  it('treats `control` and `ctrl` as aliases', () => {
    expect(parseBinding('control+alt+delete')).toEqual(
      parseBinding('ctrl+alt+delete')
    );
  });

  it('rejects unmodified printable keys', () => {
    expect(parseBinding('b')).toBeNull();
    expect(parseBinding('1')).toBeNull();
    expect(parseBinding(',')).toBeNull();
  });

  it('accepts unmodified non-printables (Escape, F-keys, arrows)', () => {
    expect(parseBinding('escape')).not.toBeNull();
    expect(parseBinding('f1')).not.toBeNull();
    expect(parseBinding('arrowup')).not.toBeNull();
  });

  it('rejects modifiers-only with no key', () => {
    expect(parseBinding('mod+shift')).toBeNull();
    expect(parseBinding('ctrl')).toBeNull();
  });

  it('rejects ambiguous multi-key bindings', () => {
    expect(parseBinding('mod+b+c')).toBeNull();
  });

  it('handles literal plus key', () => {
    const parsed = parseBinding('ctrl++');
    expect(parsed).toEqual({
      mod: false,
      ctrl: true,
      alt: false,
      shift: false,
      key: 'plus'
    });
  });

  it('aliases space and arrows', () => {
    expect(parseBinding('mod+space')?.key).toBe('space');
    expect(parseBinding('mod+up')?.key).toBe('arrowup');
  });

  it('rejects unknown tokens cleanly', () => {
    // empty token after a stray plus
    expect(parseBinding('mod++a')).toBeNull();
  });
});

describe('formatChord', () => {
  it('round-trips through parseBinding', () => {
    const inputs = ['mod+b', 'mod+shift+z', 'ctrl+alt+1', 'escape', 'f5'];
    for (const inp of inputs) {
      const chord = parseBinding(inp);
      expect(chord).not.toBeNull();
      if (!chord) continue;
      // Format and re-parse — same chord must come back.
      const fmt = formatChord(chord);
      expect(parseBinding(fmt)).toEqual(chord);
    }
  });

  it('produces canonical modifier order (mod, ctrl, alt, shift, key)', () => {
    const chord = parseBinding('shift+alt+ctrl+mod+b');
    expect(chord).not.toBeNull();
    if (!chord) return;
    expect(formatChord(chord)).toBe('mod+ctrl+alt+shift+b');
  });
});

describe('canonicalize', () => {
  it('passes null through', () => {
    expect(canonicalize(null)).toBeNull();
  });

  it('returns null for invalid input', () => {
    expect(canonicalize('garbage')).toBeNull();
    expect(canonicalize('b')).toBeNull();
  });

  it('returns canonical form for valid input', () => {
    expect(canonicalize('Mod+Shift+B')).toBe('mod+shift+b');
    expect(canonicalize('mod+mod+b')).toBe('mod+b');
  });
});

describe('bindingsConflict', () => {
  it('false when either side is null', () => {
    expect(bindingsConflict(null, 'mod+b')).toBe(false);
    expect(bindingsConflict('mod+b', null)).toBe(false);
    expect(bindingsConflict(null, null)).toBe(false);
  });

  it('detects identical bindings ignoring formatting', () => {
    expect(bindingsConflict('Mod+B', 'mod+b')).toBe(true);
    expect(bindingsConflict('shift+mod+z', 'mod+shift+z')).toBe(true);
  });

  it('treats different bindings as non-conflicting', () => {
    expect(bindingsConflict('mod+b', 'mod+i')).toBe(false);
    expect(bindingsConflict('mod+b', 'mod+shift+b')).toBe(false);
  });

  it('treats invalid bindings as non-conflicting (defensive)', () => {
    expect(bindingsConflict('mod+b', 'garbage')).toBe(false);
  });
});
