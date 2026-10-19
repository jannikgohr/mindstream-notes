import { describe, expect, it, vi } from 'vitest';
import { vaultColor, vaultTileColor, vaultTileLetter } from './tile';

describe('vaultColor', () => {
  it('uses the colour stored in profiles.json', () => {
    expect(vaultColor({ id: 'default', color: 'teal' })).toBe('teal');
  });

  it("falls back to the ID's colour, the same slot the backend starts from", () => {
    // The values color_slot gives in src-tauri/src/profiles/tests.rs.
    expect(vaultTileColor('default')).toBe(6);
    expect(vaultTileColor('work')).toBe(0);
    expect(vaultTileColor('uni')).toBe(1);
    expect(vaultColor({ id: 'default' })).toBe('violet');
    // A colour only a newer build knows falls back the same way.
    expect(vaultColor({ id: 'default', color: 'slate-blue' })).toBe('violet');
  });
});

describe('vaultTileLetter', () => {
  it('upper-cases the first character and keeps emoji and accents whole', () => {
    expect(vaultTileLetter('work')).toBe('W');
    expect(vaultTileLetter('  uni ')).toBe('U');
    expect(vaultTileLetter('éCole')).toBe('É');
    expect(vaultTileLetter('📚 Reading')).toBe('📚');
    expect(vaultTileLetter('👩‍💻 Code')).toBe('👩‍💻');
  });

  it('falls back to a question mark for an empty name', () => {
    expect(vaultTileLetter('')).toBe('?');
    expect(vaultTileLetter('   ')).toBe('?');
  });

  it('still keeps accents and emoji whole without Intl.Segmenter', () => {
    vi.stubGlobal(
      'Intl',
      Object.assign(Object.create(Intl), { Segmenter: undefined })
    );
    try {
      expect(vaultTileLetter('éCole')).toBe('É');
      // One code point, two UTF-16 units: indexing would split the pair.
      expect(vaultTileLetter('📚 Reading')).toBe('📚');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
