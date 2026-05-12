/**
 * Apply the user's accent colour by overriding three shadcn CSS vars
 * on `document.documentElement`:
 *
 *   --primary             the colour itself (button backgrounds,
 *                         active-state highlights, dot indicators, etc.)
 *   --primary-foreground  white, so dark accents stay legible
 *   --ring                same colour, so focus rings match the accent
 *
 * The setting is treated as "no override" while it matches the schema
 * default — applying `#0a0a0a` blindly would make dark-mode primary
 * buttons disappear (the default dark `--primary` is near-white, so
 * forcing a near-black value here breaks contrast). Anything the user
 * actually picks via the colour input overrides both themes.
 *
 * White is chosen as foreground unconditionally — works for any
 * vibrant accent (blue, violet, teal, red, …); for very light accents
 * (yellow) the user can pick a different colour or we'll add a
 * luminance check if it becomes a problem.
 */

const HEX_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const VARS = ['--primary', '--primary-foreground', '--ring'] as const;

export function applyAccentColor(color: string): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!color || !HEX_PATTERN.test(color)) {
    clearAccentColor();
    return;
  }
  root.style.setProperty('--primary', color);
  root.style.setProperty('--primary-foreground', '#ffffff');
  root.style.setProperty('--ring', color);
}

export function clearAccentColor(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const name of VARS) root.style.removeProperty(name);
}
