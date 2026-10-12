import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BUILTIN_PRESETS,
  applyThemeAppearance,
  parseThemePreset,
  resolvedPreset,
  themeContrast
} from './theme-presets';

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
    const warm = BUILTIN_PRESETS[1];
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
