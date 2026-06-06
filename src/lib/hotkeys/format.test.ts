import { describe, expect, it } from 'vitest';
import { tauriAccelerator } from './format';

describe('tauriAccelerator', () => {
  it('formats mod as Tauri CmdOrCtrl', () => {
    expect(tauriAccelerator('mod+b')).toBe('CmdOrCtrl+B');
  });

  it('preserves explicit modifiers before the key', () => {
    expect(tauriAccelerator('mod+alt+shift+1')).toBe('CmdOrCtrl+Alt+Shift+1');
  });

  it('formats punctuation and special keys for muda parsing', () => {
    expect(tauriAccelerator('mod+,')).toBe('CmdOrCtrl+,');
    expect(tauriAccelerator('ctrl++')).toBe('Ctrl++');
    expect(tauriAccelerator('alt+arrowup')).toBe('Alt+ArrowUp');
  });

  it('returns null for unset or invalid bindings', () => {
    expect(tauriAccelerator(null)).toBeNull();
    expect(tauriAccelerator('garbage')).toBeNull();
  });
});
