/**
 * A vault's tile: the first letter of its name on the vault's named colour
 * (`--named-<color>`, see NAMED_COLORS), which each theme renders its own way.
 *
 * The backend stores the colour in profiles.json when a vault is created or
 * an older index is first loaded, so it never changes afterwards.
 */
import {
  isNamedColor,
  NAMED_COLORS,
  type NamedColor
} from '$lib/settings/theme-presets';

/** A colour slot for a vault ID (FNV-1a), matching `color_slot` in profiles.rs. */
export function vaultTileColor(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % NAMED_COLORS.length;
}

/**
 * The vault's stored colour. Without one (the browser build, or a colour only
 * a newer build knows) it falls back to its ID's colour.
 */
export function vaultColor(vault: {
  id: string;
  color?: string | null;
}): NamedColor {
  return isNamedColor(vault.color)
    ? vault.color
    : NAMED_COLORS[vaultTileColor(vault.id)];
}

/** The name's first character, upper-cased. Emoji and accents stay whole. */
export function vaultTileLetter(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const first =
    typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter().segment(trimmed)[Symbol.iterator]().next().value
          ?.segment
      : Array.from(trimmed)[0];
  return (first ?? trimmed[0]).toLocaleUpperCase();
}
