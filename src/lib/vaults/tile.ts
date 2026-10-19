/**
 * A vault's tile: the first letter of its name on one of the
 * `--vault-tile-N` colours in app.css (Apollo's eight named colours).
 *
 * The colour comes from the ID and the vault list, so renaming a vault
 * changes its letter but not its colour, and nothing needs storing.
 */

/** How many `--vault-tile-N` colours app.css defines. */
export const VAULT_TILE_COLORS = 8;

/** A stable colour slot for a vault ID (FNV-1a). */
export function vaultTileColor(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % VAULT_TILE_COLORS;
}

/**
 * Colour slots for a vault list in creation order, which is the order of the
 * profiles index. Each vault takes its ID's slot unless an older vault holds
 * it, then the next free one three hues on, so it does not land on a
 * neighbouring hue. Up to eight vaults never share a colour, and adding a
 * vault never recolours an older one. Removing one can hand its slot back to
 * a later vault that was moved off it.
 */
export function vaultTileSlots(ids: readonly string[]): Map<string, number> {
  const slots = new Map<string, number>();
  const taken = new Set<number>();
  for (const id of ids) {
    let slot = vaultTileColor(id);
    if (taken.size < VAULT_TILE_COLORS)
      // 3 and 8 share no factor, so the steps still reach every slot.
      while (taken.has(slot)) slot = (slot + 3) % VAULT_TILE_COLORS;
    taken.add(slot);
    slots.set(id, slot);
  }
  return slots;
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
