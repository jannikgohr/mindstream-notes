/**
 * Apply the user's accent colour by overriding the brand tokens on
 * `document.documentElement`:
 *
 *   --accent-brand             the colour itself (links, mentions, selection,
 *                              active-state emphasis)
 *   --accent-brand-foreground  black or white, chosen for fill contrast
 *   --ring                     same colour, so focus rings match the accent
 *
 * Deliberately NOT --primary. --primary is the neutral high-contrast button
 * surface (near-black in light, near-white in dark); repainting it meant every
 * neutral button in the app turned into the user's accent. Now that identity
 * lives in its own token (see docs/theming.md), the accent tints identity
 * surfaces only and leaves neutral chrome alone.
 *
 * Theme application calls this after preset tokens only when an explicit
 * accent value exists. Clearing that value restores the preset's separate
 * light and dark accents. The foreground uses the RGB channels' luminance.
 */

const HEX_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const VARS = ['--accent-brand', '--accent-brand-foreground', '--ring'] as const;

export function accentForeground(color: string): string {
  let hex = color.slice(1);
  if (hex.length === 3 || hex.length === 4)
    hex = hex
      .slice(0, 3)
      .split('')
      .map((char) => char + char)
      .join('');
  const [r, g, b] = [0, 2, 4].map((index) => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? '#000000' : '#ffffff';
}

export function applyAccentColor(color: string): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!color || !HEX_PATTERN.test(color)) {
    clearAccentColor();
    return;
  }
  root.style.setProperty('--accent-brand', color);
  root.style.setProperty('--accent-brand-foreground', accentForeground(color));
  root.style.setProperty('--ring', color);
}

export function clearAccentColor(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const name of VARS) root.style.removeProperty(name);
  /* Legacy: builds before the brand-token split wrote the accent onto
   * --primary. A stale inline value would survive here because nothing else
   * clears it, leaving neutral buttons permanently tinted. */
  root.style.removeProperty('--primary');
  root.style.removeProperty('--primary-foreground');
}
