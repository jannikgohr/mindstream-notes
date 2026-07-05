import { describe, expect, it } from 'vitest';
import {
  inkBounds,
  padPlacement,
  parseHexColor,
  renderInkPixels
} from './signature-image-render';
import {
  SIGNATURE_PAD_HEIGHT,
  SIGNATURE_PAD_MARGIN,
  SIGNATURE_PAD_WIDTH
} from './signature-trace';

describe('inkBounds', () => {
  it('finds the tight bounding box of non-zero entries', () => {
    // 4×3 plane with coverage at (1,0) and (3,2).
    const plane = new Uint8Array(12);
    plane[0 * 4 + 1] = 128;
    plane[2 * 4 + 3] = 255;
    expect(inkBounds(plane, 4)).toEqual({
      minX: 1,
      minY: 0,
      maxX: 3,
      maxY: 2
    });
  });

  it('returns null for an all-zero plane', () => {
    expect(inkBounds(new Uint8Array(12), 4)).toBeNull();
  });
});

describe('parseHexColor', () => {
  it('parses #rrggbb', () => {
    expect(parseHexColor('#112837')).toEqual([17, 40, 55]);
  });

  it('falls back to the ink colour for malformed input', () => {
    expect(parseHexColor('#123')).toEqual([17, 24, 39]);
    expect(parseHexColor('#zzzzzz')).toEqual([17, 24, 39]);
  });
});

describe('renderInkPixels', () => {
  it('crops to the bounds and carries coverage into the alpha channel', () => {
    // 4×3 plane: full coverage at (1,1), half coverage at (2,1).
    const plane = new Uint8Array(12);
    plane[1 * 4 + 1] = 255;
    plane[1 * 4 + 2] = 128;
    const bounds = inkBounds(plane, 4)!;
    const ink = renderInkPixels(plane, 4, bounds, [10, 20, 30]);
    expect(ink.width).toBe(2);
    expect(ink.height).toBe(1);
    // First pixel: stroke colour at alpha 255.
    expect(Array.from(ink.data.slice(0, 4))).toEqual([10, 20, 30, 255]);
    // Second pixel: same colour at the partial coverage.
    expect(Array.from(ink.data.slice(4, 8))).toEqual([10, 20, 30, 128]);
  });

  it('leaves uncovered pixels fully transparent', () => {
    // Coverage only in two opposite corners; the middle stays clear.
    const plane = new Uint8Array(9);
    plane[0] = 255;
    plane[8] = 255;
    const ink = renderInkPixels(plane, 3, inkBounds(plane, 3)!, [10, 20, 30]);
    const centre = (1 * 3 + 1) * 4;
    expect(Array.from(ink.data.slice(centre, centre + 4))).toEqual([
      0, 0, 0, 0
    ]);
  });
});

describe('padPlacement', () => {
  const boxW = SIGNATURE_PAD_WIDTH - SIGNATURE_PAD_MARGIN * 2;
  const boxH = SIGNATURE_PAD_HEIGHT - SIGNATURE_PAD_MARGIN * 2;

  it('fits a wide source to the pad width and centres it vertically', () => {
    const p = padPlacement(boxW * 4, boxH);
    expect(p.width).toBe(boxW);
    expect(p.x).toBe(SIGNATURE_PAD_MARGIN);
    // Uniform scale: height shrank by the same factor and is centred.
    expect(p.height).toBe(Math.round(boxH / 4));
    expect(p.y).toBe(Math.round((SIGNATURE_PAD_HEIGHT - p.height) / 2));
  });

  it('fits a tall source to the pad height', () => {
    const p = padPlacement(50, boxH * 3);
    expect(p.height).toBe(boxH);
    expect(p.y).toBe(SIGNATURE_PAD_MARGIN);
  });

  it('never collapses below one pixel', () => {
    const p = padPlacement(10000, 1);
    expect(p.height).toBeGreaterThanOrEqual(1);
    expect(p.width).toBeGreaterThanOrEqual(1);
  });
});
