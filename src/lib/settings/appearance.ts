/**
 * Apply the user's typography / density appearance settings by writing CSS
 * custom properties (and one data attribute) onto `document.documentElement`,
 * the same shape as accent.ts. Kept as pure DOM writes so +layout.svelte can
 * drive them from a `$effect` and tests can assert the resulting inline
 * styles.
 *
 * Defaults for each var live in app.css (`:root`), so first paint is already
 * correct before this JS runs — these setters only update the vars when the
 * value changes. Bounds mirror the slider definitions in schema.json;
 * clamping here stops a corrupt stored value (hand-edited localStorage, an
 * older build) from producing an absurd layout.
 */

function clamp(value: unknown, min: number, max: number, fallback: number) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * UI font size drives the root `font-size`, so every rem-based measurement in
 * the chrome (text, padding, control heights) scales together — the standard
 * "app zoom" behaviour. Editor body text is sized independently via
 * `--editor-font-size` (see applyEditorTypography).
 */
export function applyUiFontSize(px: unknown): void {
  if (typeof document === 'undefined') return;
  const size = clamp(px, 12, 18, 14);
  document.documentElement.style.setProperty('--ui-font-size', `${size}px`);
}
