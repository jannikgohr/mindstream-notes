import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BUILTIN_PRESETS,
  applyThemeAppearance,
  currentThemeWindowBackground,
  parseThemePreset,
  resolvedPreset,
  themeContrast,
  THEME_TOKENS,
  type ThemeColor
} from './theme-presets';

const css = readFileSync('src/app.css', 'utf8');
/** First `--name: oklch(…)` after the given block opener, as [L, C, H]. */
function cssToken(block: RegExp, name: string): ThemeColor | undefined {
  const source = css.slice(css.search(block));
  const value = source.match(new RegExp(`--${name}:\\s*oklch\\(([^)]*)\\);`));
  return value?.[1].split(' ').map(Number) as ThemeColor | undefined;
}
const ROOT = /^:root\s*\{/m;
const DARK = /^\.dark\s*\{/m;

afterEach(() => {
  document.documentElement.removeAttribute('style');
  document.documentElement.className = '';
  localStorage.clear();
});
describe('theme preset contract', () => {
  it('ships readable light/dark palettes with ordered surfaces', () => {
    for (const preset of BUILTIN_PRESETS)
      for (const palette of [preset.light, preset.dark]) {
        expect(parseThemePreset(preset)).toEqual(preset);
        expect(
          themeContrast(palette.foreground, palette['surface-0'])
        ).toBeGreaterThanOrEqual(4.5);
        expect(palette['surface-3'][0]).toBeGreaterThan(
          palette['surface-0'][0]
        );
      }
  });
  it('rejects scripts, CSS, remote imports, paths and unreadable palettes', () => {
    for (const patch of [
      { id: '../evil' },
      { css: '@import url(https://example.com)' },
      { version: 2 }
    ])
      expect(() =>
        parseThemePreset({ ...BUILTIN_PRESETS[0], ...patch })
      ).toThrow();
    const preset = structuredClone(BUILTIN_PRESETS[0]);
    const border = structuredClone(preset);
    border.dark['border-subtle'] = border.dark['surface-1'];
    expect(() => parseThemePreset(border)).toThrow();
    preset.dark.foreground = preset.dark['surface-1'];
    expect(() => parseThemePreset(preset)).toThrow();
  });
  it('switches mode independently and applies an explicit accent after preset tokens', () => {
    const warm = BUILTIN_PRESETS.find((preset) => preset.id === 'warm')!;
    applyThemeAppearance(warm, false, '#123456', 14);
    expect(document.documentElement.style.getPropertyValue('--surface-1')).toBe(
      `oklch(${warm.light['surface-1'].join(' ')})`
    );
    expect(
      document.documentElement.style.getPropertyValue('--accent-brand')
    ).toBe('#123456');
    expect(
      document.documentElement.style.getPropertyValue('--ui-font-size')
    ).toBe('14px');
    applyThemeAppearance(warm, true, '#123456', 14);
    expect(document.documentElement.style.getPropertyValue('--surface-1')).toBe(
      `oklch(${warm.dark['surface-1'].join(' ')})`
    );
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe(
      `oklch(${warm.dark.primary.join(' ')})`
    );
    applyThemeAppearance(warm, true, undefined, 16);
    expect(
      document.documentElement.style.getPropertyValue('--accent-brand')
    ).toBe(`oklch(${warm.dark['accent-brand'].join(' ')})`);
  });
  it('makes Apollo the default and keeps the earlier presets', () => {
    expect(BUILTIN_PRESETS.map((preset) => [preset.id, preset.name])).toEqual([
      ['default', 'Apollo'],
      ['slate', 'Slate & Indigo'],
      ['paper', 'Paper & Teal'],
      ['warm', 'Warm'],
      ['forest', 'Forest']
    ]);
  });
  it('mirrors the default preset in the app.css base tokens and pre-paint colours', () => {
    const [preset] = BUILTIN_PRESETS;
    for (const name of THEME_TOKENS) {
      expect(cssToken(ROOT, name), name).toEqual(preset.light[name]);
      expect(cssToken(DARK, name), name).toEqual(preset.dark[name]);
    }
    const html = readFileSync('src/app.html', 'utf8');
    for (const mode of ['light', 'dark'] as const)
      for (const name of ['surface-1', 'foreground'] as const)
        expect(html).toContain(
          `var(--${name}, oklch(${preset[mode][name].join(' ')}))`
        );
  });
  it('keeps the shared status colours readable as text on every built-in preset', () => {
    for (const status of ['success', 'warning', 'info', 'destructive'])
      for (const [block, mode] of [
        [ROOT, 'light'],
        [DARK, 'dark']
      ] as const) {
        const color = cssToken(block, status)!;
        for (const preset of BUILTIN_PRESETS)
          for (const surface of [
            'surface-0',
            'surface-1',
            'surface-2',
            'surface-3'
          ] as const)
            expect(
              themeContrast(color, preset[mode][surface]),
              `${status} on ${preset.id} ${mode} ${surface}`
            ).toBeGreaterThanOrEqual(4.5);
      }
  });
  it('falls back without mutating a missing user selection', () => {
    const selection = { id: 'missing-user-theme' };
    expect(resolvedPreset(BUILTIN_PRESETS, selection.id).id).toBe('default');
    expect(selection.id).toBe('missing-user-theme');
  });
  it('applies a cached preset before app CSS and rejects unrestricted cached CSS', () => {
    const html = readFileSync('src/app.html', 'utf8');
    const script = html
      .match(/<script>\s*\/\/ Numeric preset[\s\S]*?<\/script>/)?.[0]
      .replace(/^<script>|<\/script>$/g, '');
    expect(script).toBeTruthy();
    const preset = BUILTIN_PRESETS[2];
    localStorage.setItem(
      'mindstream:appearance:v1',
      JSON.stringify({ preset, accent: '#ffffff', uiFontSize: 18 })
    );
    document.documentElement.classList.add('dark');
    new Function(script!)();
    expect(document.documentElement.style.getPropertyValue('--surface-1')).toBe(
      `oklch(${preset.dark['surface-1'].join(' ')})`
    );
    expect(
      document.documentElement.style.getPropertyValue(
        '--accent-brand-foreground'
      )
    ).toBe('#000000');
    document.documentElement.removeAttribute('style');
    localStorage.setItem(
      'mindstream:appearance:v1',
      JSON.stringify({
        preset: {
          ...preset,
          dark: { ...preset.dark, 'surface-1': 'url(https://example.com)' }
        }
      })
    );
    new Function(script!)();
    expect(document.documentElement.style.length).toBe(0);
  });
});

describe('native window background', () => {
  const brightness = ({
    red,
    green,
    blue
  }: {
    red: number;
    green: number;
    blue: number;
  }) => red + green + blue;

  it('paints the cached preset surface in the current mode', () => {
    const fallback = currentThemeWindowBackground();
    expect(fallback.alpha).toBe(255);
    for (const channel of [fallback.red, fallback.green, fallback.blue]) {
      expect(Number.isInteger(channel)).toBe(true);
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(255);
    }
    localStorage.setItem(
      'mindstream:appearance:v1',
      JSON.stringify({ preset: BUILTIN_PRESETS[1] })
    );
    const light = currentThemeWindowBackground();
    document.documentElement.classList.add('dark');
    const dark = currentThemeWindowBackground();
    expect(brightness(dark)).toBeLessThan(brightness(light));
  });

  it('falls back to the first built-in surface for a corrupt cache', () => {
    const fallback = currentThemeWindowBackground();
    localStorage.setItem('mindstream:appearance:v1', '{broken');
    expect(currentThemeWindowBackground()).toEqual(fallback);
  });

  it('still applies a theme when the appearance cache cannot be written', () => {
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('quota exceeded');
      });
    expect(() =>
      applyThemeAppearance(BUILTIN_PRESETS[0], false, null, 16)
    ).not.toThrow();
    expect(document.documentElement.dataset.themePreset).toBe(
      BUILTIN_PRESETS[0].id
    );
    setItem.mockRestore();
  });
});
