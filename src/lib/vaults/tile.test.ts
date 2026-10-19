import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { themeContrast, type ThemeColor } from '$lib/settings/theme-presets';
import {
  VAULT_TILE_COLORS,
  vaultTileColor,
  vaultTileLetter,
  vaultTileSlots
} from './tile';

const css = readFileSync('src/app.css', 'utf8');
function token(name: string): ThemeColor {
  const value = css.match(new RegExp(`--${name}:\\s*oklch\\(([^)]*)\\);`));
  expect(value, name).toBeTruthy();
  return value![1].split(' ').map(Number) as ThemeColor;
}

describe('vaultTileColor', () => {
  it('keeps a vault on one colour and spreads vaults across all of them', () => {
    expect(vaultTileColor('default')).toBe(vaultTileColor('default'));
    const slots = new Set(
      Array.from({ length: 200 }, (_, index) =>
        vaultTileColor(`vault-${index}`)
      )
    );
    expect([...slots].sort()).toEqual(
      Array.from({ length: VAULT_TILE_COLORS }, (_, index) => index)
    );
  });

  it('has a readable app.css colour for every slot', () => {
    const letter = token('vault-tile-foreground');
    for (let slot = 0; slot < VAULT_TILE_COLORS; slot++)
      expect(
        themeContrast(token(`vault-tile-${slot}`), letter),
        `slot ${slot}`
      ).toBeGreaterThanOrEqual(4.5);
  });
});

describe('vaultTileSlots', () => {
  // Ten IDs that all hash to the same slot.
  const clashing = Array.from({ length: 4000 }, (_, index) => `vault-${index}`)
    .filter((id) => vaultTileColor(id) === vaultTileColor('vault-0'))
    .slice(0, 10);

  it('gives up to eight vaults different colours, oldest first', () => {
    const slots = vaultTileSlots(clashing.slice(0, 8));
    expect(slots.get(clashing[0])).toBe(vaultTileColor(clashing[0]));
    expect(new Set(slots.values()).size).toBe(8);
  });

  it('never recolours an older vault when one is added', () => {
    const before = vaultTileSlots(clashing.slice(0, 3));
    const after = vaultTileSlots(clashing.slice(0, 4));
    for (const id of clashing.slice(0, 3))
      expect(after.get(id)).toBe(before.get(id));
  });

  it('repeats colours only past eight vaults', () => {
    const slots = vaultTileSlots(clashing);
    expect(slots.get(clashing[8])).toBe(vaultTileColor(clashing[8]));
    expect(slots.size).toBe(10);
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
});
