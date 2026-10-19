import { describe, expect, it } from 'vitest';
import schema from '$lib/settings/schema.json';
import {
  centeredPatternPositions,
  INK_COLOR_SWATCHES,
  normalizeInkPageBackgroundOpacity
} from './editor-helpers';

/** WCAG contrast of an sRGB hex colour against the white page. */
function contrastOnWhite(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}

describe('INK_COLOR_SWATCHES', () => {
  it('starts with the default pen colour and stays readable on the page', () => {
    const { categories } = schema as {
      categories: {
        sections: { settings: { id: string; default?: unknown }[] }[];
      }[];
    };
    const color = categories
      .flatMap((category) => category.sections)
      .flatMap((section) => section.settings)
      .find((setting) => setting.id === 'editor.ink.color');
    expect(color?.default).toBe(INK_COLOR_SWATCHES[0]);
    for (const swatch of INK_COLOR_SWATCHES)
      expect(contrastOnWhite(swatch), swatch).toBeGreaterThanOrEqual(3);
  });
});

describe('normalizeInkPageBackgroundOpacity', () => {
  it('maps percentages to a clamped 0-1 multiplier', () => {
    expect(normalizeInkPageBackgroundOpacity(50)).toBe(0.5);
    expect(normalizeInkPageBackgroundOpacity('25')).toBe(0.25);
    expect(normalizeInkPageBackgroundOpacity(-10)).toBe(0);
    expect(normalizeInkPageBackgroundOpacity(150)).toBe(1);
    expect(normalizeInkPageBackgroundOpacity('garbage')).toBe(1);
  });
});

describe('centeredPatternPositions', () => {
  it('centers a repeating pattern inside the available span', () => {
    const positions = centeredPatternPositions(0, 100, 28);

    expect(positions).toEqual([22, 50, 78]);
  });

  it('returns no marks when the step cannot fit', () => {
    expect(centeredPatternPositions(0, 20, 28)).toEqual([]);
  });
});
