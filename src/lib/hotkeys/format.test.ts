import { describe, expect, it } from 'vitest';
import {
  globalShortcutAccelerator,
  globalShortcutSupportReason,
  tauriAccelerator
} from './format';

describe('tauriAccelerator', () => {
  it('formats mod as Tauri CmdOrCtrl', () => {
    expect(tauriAccelerator('mod+b')).toBe('CommandOrControl+B');
  });

  it('preserves explicit modifiers before the key', () => {
    expect(tauriAccelerator('mod+alt+shift+1')).toBe(
      'CommandOrControl+Alt+Shift+1'
    );
  });

  it('formats punctuation and special keys for muda parsing', () => {
    expect(tauriAccelerator('mod+,')).toBe('CommandOrControl+,');
    expect(tauriAccelerator('ctrl++')).toBe('Ctrl++');
    expect(tauriAccelerator('alt+arrowup')).toBe('Alt+ArrowUp');
  });

  it('returns null for unset or invalid bindings', () => {
    expect(tauriAccelerator(null)).toBeNull();
    expect(tauriAccelerator('garbage')).toBeNull();
  });
});

describe('globalShortcutSupportReason', () => {
  // Every key in the plugin's keyToCodeMap must report null here, and
  // anything outside must report "unsupported-key". The test isn't
  // exhaustive over the whole vocabulary — that's the map's job — but
  // it covers the categories (letter, digit, F-key, US symbol, named,
  // alias) plus the empirically-broken layout-specific cases.

  it('accepts letters, digits, and F-keys', () => {
    expect(globalShortcutSupportReason('mod+alt+n')).toBeNull();
    expect(globalShortcutSupportReason('mod+shift+1')).toBeNull();
    expect(globalShortcutSupportReason('mod+f12')).toBeNull();
  });

  it('accepts the standard US punctuation row', () => {
    expect(globalShortcutSupportReason('mod+;')).toBeNull();
    expect(globalShortcutSupportReason('mod+/')).toBeNull();
    expect(globalShortcutSupportReason('mod+[')).toBeNull();
  });

  it('accepts named keys (space, enter, arrows, escape)', () => {
    expect(globalShortcutSupportReason('mod+space')).toBeNull();
    expect(globalShortcutSupportReason('mod+arrowleft')).toBeNull();
    expect(globalShortcutSupportReason('mod+escape')).toBeNull();
  });

  it('accepts the minus alias the parser emits for "-"', () => {
    // parseBinding canonicalises "-" to "minus" via KEY_ALIASES; the
    // global vocabulary maps that back to the plugin's "Minus" code.
    expect(globalShortcutSupportReason('mod+-')).toBeNull();
  });

  it('rejects layout-specific characters', () => {
    // ö / ä / ü / ß / é register without an error in the plugin but
    // never dispatch — that's the trap we're guarding against.
    expect(globalShortcutSupportReason('mod+alt+ö')).toBe('unsupported-key');
    expect(globalShortcutSupportReason('mod+alt+ä')).toBe('unsupported-key');
    expect(globalShortcutSupportReason('mod+ß')).toBe('unsupported-key');
  });

  it('rejects the plus alias because "+" is Shift+= on US', () => {
    // "+" isn't a base key in the plugin's vocabulary. Users who want
    // it must bind shift+= instead, which canonicalises differently.
    expect(globalShortcutSupportReason('mod+plus')).toBe('unsupported-key');
  });

  it('treats null and unparseable input as unsupported', () => {
    expect(globalShortcutSupportReason(null)).toBe('unsupported-key');
    expect(globalShortcutSupportReason('garbage')).toBe('unsupported-key');
  });
});

describe('globalShortcutAccelerator', () => {
  it('emits the Tauri PascalCase code for supported keys', () => {
    expect(globalShortcutAccelerator('mod+alt+n')).toBe(
      'CommandOrControl+Alt+KeyN'
    );
    expect(globalShortcutAccelerator('mod+;')).toBe(
      'CommandOrControl+Semicolon'
    );
    expect(globalShortcutAccelerator('mod+f1')).toBe('CommandOrControl+F1');
    expect(globalShortcutAccelerator('alt+arrowleft')).toBe('Alt+ArrowLeft');
  });

  it('returns null for unsupported keys so +layout skips registration', () => {
    expect(globalShortcutAccelerator('mod+alt+ö')).toBeNull();
    expect(globalShortcutAccelerator(null)).toBeNull();
  });
});
