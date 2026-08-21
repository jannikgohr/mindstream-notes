/**
 * Apply the user's accent colour by overriding the brand tokens on
 * `document.documentElement`:
 *
 *   --accent-brand             the colour itself (links, mentions, selection,
 *                              active-state emphasis)
 *   --accent-brand-foreground  white, so dark accents stay legible
 *   --ring                     same colour, so focus rings match the accent
 *
 * Deliberately NOT --primary. --primary is the neutral high-contrast button
 * surface (near-black in light, near-white in dark); repainting it meant every
 * neutral button in the app turned into the user's accent. Now that identity
 * lives in its own token (see docs/theming.md), the accent tints identity
 * surfaces only and leaves neutral chrome alone.
 *
 * +layout.svelte only calls this when the setting is *modified*, so an
 * untouched install keeps the theme's own --accent-brand — which, unlike a
 * single user-supplied hex, carries separate light and dark values.
 *
 * White is chosen as foreground unconditionally — works for any vibrant accent
 * (blue, violet, teal, red, …); for very light accents (yellow) the user can
 * pick a different colour or we'll add a luminance check if it becomes a
 * problem.
 */

const HEX_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const VARS = ['--accent-brand', '--accent-brand-foreground', '--ring'] as const;

export function applyAccentColor(color: string): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!color || !HEX_PATTERN.test(color)) {
    clearAccentColor();
    return;
  }
  root.style.setProperty('--accent-brand', color);
  root.style.setProperty('--accent-brand-foreground', '#ffffff');
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
