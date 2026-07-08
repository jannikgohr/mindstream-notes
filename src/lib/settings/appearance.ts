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
  const size = clamp(px, 12, 18, 16);
  document.documentElement.style.setProperty('--ui-font-size', `${size}px`);
}

/**
 * Editor body text is sized in absolute px (via `--editor-font-size`) rather
 * than rem so it stays fixed regardless of the UI font-size zoom; line height
 * is unitless so it tracks whatever font size is in effect. app.css applies
 * both to the ProseMirror content — headings/blocks inside scale relative to
 * the body size through their own em-based rules.
 *
 * `lineHeight` is nullable: pass `null` (the caller does this while the
 * setting is at its default) to clear the var so the ProseMirror rule falls
 * back to `normal`, reproducing Crepe's native line spacing rather than
 * forcing a numeric ratio on users who never touched the slider.
 */
export function applyEditorTypography(px: unknown, lineHeight: unknown): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--editor-font-size', `${clamp(px, 12, 24, 16)}px`);
  if (lineHeight == null) {
    root.style.removeProperty('--editor-line-height');
  } else {
    root.style.setProperty(
      '--editor-line-height',
      `${clamp(lineHeight, 1.2, 2, 1.6)}`
    );
  }
}

const DENSITIES = ['compact', 'cozy', 'roomy'] as const;
type Density = (typeof DENSITIES)[number];

/**
 * UI density tunes the vertical rhythm of dense list surfaces (the file
 * tree) by exposing the choice as `html[data-density]`; app.css maps each
 * value onto the row-padding var. Unknown values fall back to `cozy`, the
 * schema default.
 */
export function applyDensity(density: unknown): void {
  if (typeof document === 'undefined') return;
  const value: Density = DENSITIES.includes(density as Density)
    ? (density as Density)
    : 'cozy';
  document.documentElement.dataset.density = value;
}
