import builtinData from './theme-presets.json';
import { applyUiFontSize } from './appearance';

export const THEME_TOKENS = [
  'surface-0',
  'surface-1',
  'surface-2',
  'surface-3',
  'border-subtle',
  'border-strong',
  'foreground',
  'muted-foreground',
  'primary',
  'primary-foreground',
  'accent-brand',
  'accent-brand-foreground'
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];
/**
 * Apollo's eight named colours, for things with a colour of their own (vault
 * tiles). Code stores the name; `--named-<name>` renders it.
 */
export const NAMED_COLORS = [
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink'
] as const;
export type NamedColor = (typeof NAMED_COLORS)[number];
export type NamedToken = `named-${NamedColor}` | 'named-foreground';
/**
 * Optional preset tokens. A palette sets all nine or none; without them the
 * app.css values apply. `named-foreground` is text on a named colour.
 */
export const NAMED_TOKENS: readonly NamedToken[] = [
  ...NAMED_COLORS.map((name) => `named-${name}` as const),
  'named-foreground'
];
export type ThemeColor = [number, number, number];
export type ThemePalette = Record<ThemeToken, ThemeColor> &
  Partial<Record<NamedToken, ThemeColor>>;

export function isNamedColor(value: unknown): value is NamedColor {
  return NAMED_COLORS.includes(value as NamedColor);
}
export interface ThemePreset {
  version: 1;
  id: string;
  name: string;
  light: ThemePalette;
  dark: ThemePalette;
}
export const THEME_CACHE_KEY = 'mindstream:appearance:v1';

export function validPresetId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

export function themeColorRgb([l, c, h]: ThemeColor): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180),
    b = c * Math.sin((h * Math.PI) / 180);
  const ll = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const ss = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss,
    -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss,
    -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss
  ].map((value) => Math.max(0, Math.min(1, value))) as [number, number, number];
}

/** Gamma-encoded sRGB bytes. */
function themeColorBytes(color: ThemeColor): [number, number, number] {
  return themeColorRgb(color).map((value) =>
    Math.round(
      255 *
        (value <= 0.0031308
          ? 12.92 * value
          : 1.055 * value ** (1 / 2.4) - 0.055)
    )
  ) as [number, number, number];
}

/** A preset colour as `rgba()`, for canvas painting where `var()` cannot reach. */
export function themeColorCss(color: ThemeColor, alpha = 1): string {
  const [red, green, blue] = themeColorBytes(color);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function luminance(color: ThemeColor): number {
  const [r, g, b] = themeColorRgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function themeContrast(a: ThemeColor, b: ThemeColor): number {
  const la = luminance(a),
    lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function parseThemePreset(value: unknown): ThemePreset {
  const fail = () => {
    throw new Error(
      'Invalid theme preset. Use version 1, numeric OKLCH tokens, increasing surface lightness and readable text contrast.'
    );
  };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail();
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some(
      (key) => !['version', 'id', 'name', 'light', 'dark'].includes(key)
    ) ||
    raw.version !== 1 ||
    !validPresetId(raw.id) ||
    typeof raw.name !== 'string' ||
    !raw.name.trim() ||
    new TextEncoder().encode(raw.name).length > 160
  )
    return fail();
  for (const mode of ['light', 'dark']) {
    const palette = raw[mode] as ThemePalette;
    if (!palette || Array.isArray(palette) || typeof palette !== 'object')
      return fail();
    const named = NAMED_TOKENS.some((key) => Object.hasOwn(palette, key));
    const expected = named ? [...THEME_TOKENS, ...NAMED_TOKENS] : THEME_TOKENS;
    if (
      Object.keys(palette).length !== expected.length ||
      expected.some((key) => !Object.hasOwn(palette, key))
    )
      return fail();
    for (const color of Object.values(palette)) {
      if (
        !Array.isArray(color) ||
        color.length !== 3 ||
        color.some((n) => typeof n !== 'number' || !Number.isFinite(n)) ||
        color[0] < 0 ||
        color[0] > 1 ||
        color[1] < 0 ||
        color[1] > 0.4 ||
        color[2] < 0 ||
        color[2] > 360
      )
        return fail();
    }
    const surfaces = [
      palette['surface-0'],
      palette['surface-1'],
      palette['surface-2'],
      palette['surface-3']
    ];
    if (
      surfaces.some(
        (color, index) => index > 0 && color[0] <= surfaces[index - 1][0]
      )
    )
      return fail();
    if (
      surfaces.some(
        (color) =>
          themeContrast(color, palette.foreground) < 4.5 ||
          themeContrast(color, palette['muted-foreground']) < 4.5 ||
          themeContrast(color, palette['accent-brand']) < 3 ||
          themeContrast(color, palette['border-subtle']) < 1.1 ||
          themeContrast(color, palette['border-strong']) < 1.25
      )
    )
      return fail();
    if (
      themeContrast(palette.primary, palette['primary-foreground']) < 4.5 ||
      themeContrast(
        palette['accent-brand'],
        palette['accent-brand-foreground']
      ) < 4.5
    )
      return fail();
    if (
      named &&
      NAMED_COLORS.some((name) => {
        const color = palette[`named-${name}`]!;
        return (
          themeContrast(color, palette['named-foreground']!) < 4.5 ||
          surfaces.some((surface) => themeContrast(surface, color) < 3)
        );
      })
    )
      return fail();
  }
  return structuredClone(raw) as unknown as ThemePreset;
}

export const BUILTIN_PRESETS: ThemePreset[] = builtinData.map(parseThemePreset);

export function resolvedPreset(
  presets: ThemePreset[],
  id: unknown
): ThemePreset {
  return presets.find((preset) => preset.id === id) ?? BUILTIN_PRESETS[0];
}

export function applyThemeAppearance(
  preset: ThemePreset,
  dark: boolean,
  uiFontSize: unknown
): void {
  if (typeof document === 'undefined') return;
  const palette = dark ? preset.dark : preset.light;
  for (const token of THEME_TOKENS)
    document.documentElement.style.setProperty(
      `--${token}`,
      `oklch(${palette[token].join(' ')})`
    );
  for (const token of NAMED_TOKENS) {
    const color = palette[token];
    if (color)
      document.documentElement.style.setProperty(
        `--${token}`,
        `oklch(${color.join(' ')})`
      );
    else document.documentElement.style.removeProperty(`--${token}`);
  }
  applyUiFontSize(uiFontSize);
  document.documentElement.dataset.themePreset = preset.id;
  try {
    localStorage.setItem(
      THEME_CACHE_KEY,
      JSON.stringify({ preset, uiFontSize })
    );
  } catch {
    /* storage can be unavailable */
  }
}

export function currentThemeWindowBackground(): {
  red: number;
  green: number;
  blue: number;
  alpha: number;
} {
  const dark =
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark');
  let preset = BUILTIN_PRESETS[0];
  try {
    const cache = JSON.parse(localStorage.getItem(THEME_CACHE_KEY) ?? 'null');
    if (cache?.preset) preset = parseThemePreset(cache.preset);
  } catch {
    /* validated default */
  }
  const [red, green, blue] = themeColorBytes(
    (dark ? preset.dark : preset.light)['surface-1']
  );
  return { red, green, blue, alpha: 255 };
}
