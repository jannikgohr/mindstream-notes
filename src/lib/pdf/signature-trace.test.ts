import { describe, expect, it } from 'vitest';
import type { PdfStrokePoint } from './types';
import {
  attachMeasuredWidths,
  binarizeAdaptive,
  bridgeSmallGaps,
  computeInkAlpha,
  distanceTransform,
  fitToPad,
  inkSignal,
  luminance,
  otsuThreshold,
  removeBorderBlobs,
  removeFaintComponents,
  removeSpecks,
  simplifyPolyline,
  thin,
  traceSignature,
  traceSkeleton,
  SIGNATURE_PAD_HEIGHT,
  SIGNATURE_PAD_WIDTH,
  SIGNATURE_STROKE_WIDTH,
  type BinaryMask,
  type RasterImage
} from './signature-trace';

/** Build an RGBA raster from ASCII art: `#` = black ink, `.` = white. */
function rasterFromAscii(rows: string[]): RasterImage {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = rows[y][x] === '#' ? 0 : 255;
      const o = (y * width + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

function maskFromAscii(rows: string[]): BinaryMask {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = rows[y][x] === '#' ? 1 : 0;
    }
  }
  return { width, height, data };
}

function maskToAscii(mask: BinaryMask): string[] {
  const rows: string[] = [];
  for (let y = 0; y < mask.height; y++) {
    let row = '';
    for (let x = 0; x < mask.width; x++) {
      row += mask.data[y * mask.width + x] ? '#' : '.';
    }
    rows.push(row);
  }
  return rows;
}

function inkCount(mask: BinaryMask): number {
  let n = 0;
  for (const v of mask.data) n += v;
  return n;
}

describe('luminance', () => {
  it('maps black to 0 and white to 255', () => {
    const img = rasterFromAscii(['#.', '.#']);
    expect(Array.from(luminance(img))).toEqual([0, 255, 255, 0]);
  });

  it('composites transparent pixels over white', () => {
    // A fully transparent black pixel reads as paper, not ink.
    const img: RasterImage = {
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([0, 0, 0, 0])
    };
    expect(luminance(img)[0]).toBe(255);
  });
});

describe('otsuThreshold', () => {
  it('splits a bimodal histogram between the peaks', () => {
    const gray = new Uint8Array(200);
    gray.fill(30, 0, 60); // ink cluster
    gray.fill(220, 60); // paper cluster
    const t = otsuThreshold(gray);
    expect(t).toBeGreaterThanOrEqual(30);
    expect(t).toBeLessThan(220);
  });

  it('returns a usable midpoint for a flat image', () => {
    const gray = new Uint8Array(50).fill(140);
    const t = otsuThreshold(gray);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThanOrEqual(255);
  });
});

describe('inkSignal', () => {
  it('reads coloured ink as dark via the minimum channel', () => {
    // Blue ballpoint: bright in B, dark in R. Luminance (G-weighted)
    // washes it out; the min channel keeps the ink/paper contrast.
    const bluePen: RasterImage = {
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([50, 60, 160, 255])
    };
    expect(inkSignal(bluePen)[0]).toBe(50);
    expect(luminance(bluePen)[0]).toBeGreaterThan(65);
  });

  it('composites transparency over white', () => {
    const img: RasterImage = {
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([0, 0, 0, 0])
    };
    expect(inkSignal(img)[0]).toBe(255);
  });
});

describe('binarizeAdaptive', () => {
  /** Grayscale RasterImage from a per-pixel brightness function. */
  function shadedRaster(
    width: number,
    height: number,
    value: (x: number, y: number) => number
  ): RasterImage {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = value(x, y);
        const o = (y * width + x) * 4;
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
        data[o + 3] = 255;
      }
    }
    return { width, height, data };
  }

  it('marks pixels darker than their surroundings as ink', () => {
    const img = rasterFromAscii(['........', '..###...', '........']);
    const mask = binarizeAdaptive(inkSignal(img), 8, 3, 0.5);
    expect(inkCount(mask)).toBe(3);
    expect(mask.data[1 * 8 + 2]).toBe(1);
    expect(mask.data[1 * 8 + 3]).toBe(1);
    expect(mask.data[1 * 8 + 4]).toBe(1);
  });

  it('finds no ink on a flat field', () => {
    const img = shadedRaster(30, 20, () => 180);
    expect(inkCount(binarizeAdaptive(inkSignal(img), 30, 20, 0.5))).toBe(0);
  });

  it('survives an illumination gradient that defeats any global cutoff', () => {
    // Paper brightness ramps 120 → 230 left to right; two marks sit 60
    // below their LOCAL paper level. The bright side's ink (~152) is
    // brighter than the dark side's paper (120), so no single global
    // threshold can capture both marks without eating the shaded paper
    // — the badly-lit-room failure. Local contrast separates them.
    const marks = [
      { x: 20, y: 20, r: 4 },
      { x: 100, y: 20, r: 4 }
    ];
    const paperAt = (x: number) => 120 + (110 * x) / 119;
    const img = shadedRaster(120, 40, (x, y) => {
      for (const m of marks) {
        if (Math.hypot(x - m.x, y - m.y) < m.r) return paperAt(x) - 60;
      }
      return paperAt(x);
    });
    const mask = binarizeAdaptive(inkSignal(img), 120, 40, 0.5);
    // Both mark centres are ink…
    expect(mask.data[20 * 120 + 20]).toBe(1);
    expect(mask.data[20 * 120 + 100]).toBe(1);
    // …and the paper is not, even at its darkest.
    expect(mask.data[20 * 120 + 2]).toBe(0);
    expect(mask.data[2 * 120 + 60]).toBe(0);
    // Nothing beyond the two marks (plus soft edges) got picked up.
    expect(inkCount(mask)).toBeLessThan(150);
  });

  // Hysteresis: value 200 on this scene is ~14% below the local mean —
  // under the 16% strong requirement at sensitivity 0.5, over the 8%
  // weak one — so it counts as ink exactly when it touches strong ink.
  it('accepts a weak edge pixel attached to strong ink', () => {
    const img = shadedRaster(12, 3, (x, y) =>
      y === 1 && x >= 2 && x <= 4 ? 0 : y === 1 && x === 5 ? 200 : 255
    );
    const mask = binarizeAdaptive(inkSignal(img), 12, 3, 0.5);
    expect(mask.data[1 * 12 + 5]).toBe(1);
    expect(inkCount(mask)).toBe(4);
  });

  it('rejects the same weak pixel when detached from strong ink', () => {
    const img = shadedRaster(12, 3, (x, y) =>
      y === 1 && x >= 2 && x <= 4 ? 0 : y === 1 && x === 6 ? 200 : 255
    );
    const mask = binarizeAdaptive(inkSignal(img), 12, 3, 0.5);
    expect(mask.data[1 * 12 + 6]).toBe(0);
    expect(inkCount(mask)).toBe(3);
  });

  it('finds nothing when only weak pixels exist (no seed to grow from)', () => {
    // 220 on white is ~13% contrast: weak but never strong at s=0.5.
    const img = shadedRaster(12, 3, (x, y) => (y === 1 && x === 5 ? 220 : 255));
    expect(inkCount(binarizeAdaptive(inkSignal(img), 12, 3, 0.5))).toBe(0);
  });

  it('inverts the mask when most of the frame reads as ink', () => {
    // Inverted-polarity capture (light ink on dark paper, a negative):
    // 60% of the frame is dark. Ink must always be the minority, so the
    // safeguard flips the mask — the bright minority becomes the ink.
    const img = shadedRaster(20, 20, (x) => (x < 12 ? 60 : 250));
    const mask = binarizeAdaptive(inkSignal(img), 20, 20, 0.5);
    expect(mask.data[10 * 20 + 5]).toBe(0); // dark majority: not ink
    expect(mask.data[10 * 20 + 16]).toBe(1); // bright minority: ink
  });
});

describe('bridgeSmallGaps', () => {
  it('connects dotted ink islands across 1-2 px gaps', () => {
    // Vertical dotted stroke: dots at y=1, y=4, y=7 (gaps of 2).
    const mask = maskFromAscii([
      '...',
      '.#.',
      '...',
      '...',
      '.#.',
      '...',
      '...',
      '.#.',
      '...'
    ]);
    const bridged = bridgeSmallGaps(mask);
    expect(maskToAscii(bridged)).toEqual([
      '...',
      '.#.',
      '.#.',
      '.#.',
      '.#.',
      '.#.',
      '.#.',
      '.#.',
      '...'
    ]);
  });

  it('leaves islands beyond the bridge distance separate', () => {
    const mask = maskFromAscii(['#...#....#']);
    const bridged = bridgeSmallGaps(mask);
    // 4-px gap: untouched either side.
    expect(maskToAscii(bridged)).toEqual(['#...#....#']);
  });

  it('does not mutate its input', () => {
    const mask = maskFromAscii(['#..#']);
    bridgeSmallGaps(mask);
    expect(maskToAscii(mask)).toEqual(['#..#']);
  });
});

describe('computeInkAlpha', () => {
  function shadedRaster(
    width: number,
    height: number,
    value: (x: number, y: number) => number
  ): RasterImage {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = value(x, y);
        const o = (y * width + x) * 4;
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
        data[o + 3] = 255;
      }
    }
    return { width, height, data };
  }

  it('grades coverage from opaque core through soft edge and halo to paper', () => {
    // Stroke core 0, in-mask edge 200, out-of-mask halo 225, paper 255.
    const img = shadedRaster(12, 3, (x, y) => {
      if (y !== 1) return 255;
      if (x >= 2 && x <= 4) return 0;
      if (x === 5) return 200;
      if (x === 6) return 225;
      return 255;
    });
    const signal = inkSignal(img);
    const mask = binarizeAdaptive(signal, 12, 3, 0.5);
    const alpha = computeInkAlpha(signal, mask, 0.5);
    const row = 1 * 12;
    // Core is fully opaque.
    expect(alpha[row + 3]).toBe(255);
    // The hysteresis-accepted edge pixel gets partial coverage…
    expect(alpha[row + 5]).toBeGreaterThan(0);
    expect(alpha[row + 5]).toBeLessThan(255);
    // …and the 1-px halo a fainter one still (it is not in the mask).
    expect(mask.data[row + 6]).toBe(0);
    expect(alpha[row + 6]).toBeGreaterThan(0);
    expect(alpha[row + 6]).toBeLessThan(alpha[row + 5]);
    // Plain paper stays fully transparent.
    expect(alpha[row + 10]).toBe(0);
  });

  it('keeps every mask pixel at least faintly visible', () => {
    // A bridged gap pixel is mask ink at paper brightness — the alpha
    // floor must keep it from rendering as a hole in the stroke.
    const img = shadedRaster(12, 3, (x, y) =>
      y === 1 && (x === 3 || x === 6) ? 0 : 255
    );
    const signal = inkSignal(img);
    const mask = bridgeSmallGaps(binarizeAdaptive(signal, 12, 3, 0.5));
    expect(mask.data[1 * 12 + 4]).toBe(1); // gap pixel, value 255
    const alpha = computeInkAlpha(signal, mask, 0.5);
    expect(alpha[1 * 12 + 4]).toBeGreaterThanOrEqual(64);
  });

  it('degrades to binary coverage when the ramp collapses', () => {
    // Dim scene at max sensitivity: the paper level (~29) times the 2%
    // strong contrast leaves less than one grey level of ramp — alpha
    // must fall back to mask membership instead of dividing by ~zero.
    const img = shadedRaster(8, 3, (x, y) => (y === 1 && x === 3 ? 0 : 30));
    const signal = inkSignal(img);
    const mask: BinaryMask = {
      width: 8,
      height: 3,
      data: new Uint8Array(24)
    };
    mask.data[1 * 8 + 3] = 1;
    const alpha = computeInkAlpha(signal, mask, 1);
    expect(alpha[1 * 8 + 3]).toBe(255); // mask pixel: opaque
    expect(alpha[1 * 8 + 4]).toBe(0); // eligible halo pixel: transparent
  });

  it('keeps dark pixels outside the mask transparent (despeckled noise)', () => {
    // A pitch-black isolated speck: removed from the mask, so it must
    // not reappear through the alpha plane.
    const img = shadedRaster(12, 3, (x, y) =>
      y === 1 && ((x >= 2 && x <= 4) || x === 10) ? 0 : 255
    );
    const signal = inkSignal(img);
    const cleaned = removeSpecks(binarizeAdaptive(signal, 12, 3, 0.5), 2);
    const alpha = computeInkAlpha(signal, cleaned, 0.5);
    expect(alpha[1 * 12 + 10]).toBe(0);
    expect(alpha[1 * 12 + 3]).toBe(255);
  });
});

describe('removeFaintComponents', () => {
  /** Signal plane from a per-pixel value function. */
  function signalOf(
    width: number,
    height: number,
    value: (x: number, y: number) => number
  ): Uint8Array {
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        out[y * width + x] = value(x, y);
      }
    }
    return out;
  }

  // Bold stroke (value 30) plus a pale speckle pair (240) — the kind of
  // paper grain a high-sensitivity threshold lets through.
  const boldPlusSpecks = () => {
    const width = 30;
    const height = 5;
    const isStroke = (x: number, y: number) => y === 2 && x >= 2 && x <= 15;
    const isSpeck = (x: number, y: number) => y === 2 && (x === 25 || x === 26);
    const signal = signalOf(width, height, (x, y) =>
      isStroke(x, y) ? 30 : isSpeck(x, y) ? 240 : 255
    );
    const mask: BinaryMask = {
      width,
      height,
      data: signalOf(width, height, (x, y) =>
        isStroke(x, y) || isSpeck(x, y) ? 1 : 0
      )
    };
    return { mask, signal };
  };

  it('drops pale specks next to much darker ink, keeps the ink', () => {
    const { mask, signal } = boldPlusSpecks();
    const cleaned = removeFaintComponents(mask, signal);
    expect(cleaned.data[2 * 30 + 25]).toBe(0);
    expect(cleaned.data[2 * 30 + 26]).toBe(0);
    expect(inkCount(cleaned)).toBe(14);
    // Input untouched.
    expect(inkCount(mask)).toBe(16);
  });

  it('keeps everything when the whole frame is uniformly faint pencil', () => {
    // A light line and its separate dot: no darker ink exists to make
    // either look like noise, so both survive.
    const width = 30;
    const height = 5;
    const isInk = (x: number, y: number) =>
      y === 2 && ((x >= 2 && x <= 8) || x === 20 || x === 21);
    const signal = signalOf(width, height, (x, y) => (isInk(x, y) ? 220 : 255));
    const mask: BinaryMask = {
      width,
      height,
      data: signalOf(width, height, (x, y) => (isInk(x, y) ? 1 : 0))
    };
    expect(inkCount(removeFaintComponents(mask, signal))).toBe(9);
  });

  it('is disabled by a zero ratio', () => {
    const { mask, signal } = boldPlusSpecks();
    expect(inkCount(removeFaintComponents(mask, signal, 0))).toBe(16);
  });

  it('keeps a thin stroke whose mask is mostly soft halo', () => {
    // A fast thin stroke after hysteresis growth: 5 dark core pixels
    // (100) wrapped in 10 barely-dark halo pixels (235), next to a bold
    // 14-px stroke (30). The halo majority drags the thin component's
    // MEDIAN contrast to noise level — the core percentile must see
    // through that and keep the stroke.
    const width = 30;
    const height = 7;
    const isBold = (x: number, y: number) => y === 3 && x >= 2 && x <= 15;
    const isCore = (x: number, y: number) => x === 22 && y >= 1 && y <= 5;
    const isHalo = (x: number, y: number) =>
      (x === 21 || x === 23) && y >= 1 && y <= 5;
    const signal = new Uint8Array(width * height);
    const maskData = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        signal[i] = isBold(x, y)
          ? 30
          : isCore(x, y)
            ? 100
            : isHalo(x, y)
              ? 235
              : 255;
        maskData[i] = isBold(x, y) || isCore(x, y) || isHalo(x, y) ? 1 : 0;
      }
    }
    const mask: BinaryMask = { width, height, data: maskData };
    const cleaned = removeFaintComponents(mask, signal);
    // The whole thin stroke survives, halo included.
    expect(inkCount(cleaned)).toBe(29);
  });
});

describe('removeSpecks', () => {
  it('drops components below the minimum size and keeps the rest', () => {
    const mask = maskFromAscii(['#####....', '.........', '......#..']);
    const cleaned = removeSpecks(mask, 3);
    expect(maskToAscii(cleaned)).toEqual([
      '#####....',
      '.........',
      '.........'
    ]);
    // Input untouched.
    expect(inkCount(mask)).toBe(6);
  });

  it('counts diagonal pixels as one 8-connected component', () => {
    const mask = maskFromAscii(['#..', '.#.', '..#']);
    expect(inkCount(removeSpecks(mask, 3))).toBe(3);
  });
});

describe('distanceTransform', () => {
  it('measures L∞ distance to the nearest background pixel', () => {
    const mask = maskFromAscii(['.....', '.###.', '.###.', '.###.', '.....']);
    const dist = distanceTransform(mask);
    expect(dist[2 * 5 + 2]).toBe(2); // centre of the 3×3 block
    expect(dist[1 * 5 + 1]).toBe(1); // block corner
    expect(dist[0]).toBe(0); // background
  });

  it('treats out-of-frame as ink, keeping clipped objects thick', () => {
    // A 3-row slab along the top border: nearest background is below it,
    // not the frame edge above.
    const mask = maskFromAscii(['#####', '#####', '#####', '.....']);
    const dist = distanceTransform(mask);
    expect(dist[0 * 5 + 2]).toBe(3);
    expect(dist[2 * 5 + 2]).toBe(1);
  });
});

describe('removeBorderBlobs', () => {
  it('removes a thick blob entering from the border, keeps a thin stroke', () => {
    const mask = maskFromAscii([
      '######......',
      '######......',
      '######......',
      '######......',
      '............',
      '...######...',
      '............'
    ]);
    const cleaned = removeBorderBlobs(mask, 2);
    expect(maskToAscii(cleaned)).toEqual([
      '............',
      '............',
      '............',
      '............',
      '............',
      '...######...',
      '............'
    ]);
  });

  it('keeps a thick blob that does not touch the border', () => {
    const mask = maskFromAscii([
      '.........',
      '..#####..',
      '..#####..',
      '..#####..',
      '..#####..',
      '..#####..',
      '.........'
    ]);
    expect(inkCount(removeBorderBlobs(mask, 2))).toBe(25);
  });

  it('keeps a thin stroke that touches the border', () => {
    const mask = maskFromAscii([
      '#........',
      '.#.......',
      '..#......',
      '...##....'
    ]);
    expect(inkCount(removeBorderBlobs(mask, 2))).toBe(5);
  });
});

describe('thin', () => {
  it('reduces a thick bar to a single-pixel-wide skeleton', () => {
    const mask = maskFromAscii([
      '............',
      '.##########.',
      '.##########.',
      '.##########.',
      '............'
    ]);
    const skeleton = thin(mask);
    // Every column of the bar keeps at most one pixel.
    for (let x = 1; x < 11; x++) {
      let inColumn = 0;
      for (let y = 0; y < 5; y++) {
        inColumn += skeleton.data[y * 12 + x];
      }
      expect(inColumn).toBeLessThanOrEqual(1);
    }
    // Still a connected line of roughly the bar's length.
    expect(inkCount(skeleton)).toBeGreaterThanOrEqual(6);
  });

  it('leaves an already-thin line unchanged', () => {
    const mask = maskFromAscii(['.....', '.###.', '.....']);
    expect(maskToAscii(thin(mask))).toEqual(['.....', '.###.', '.....']);
  });
});

describe('traceSkeleton', () => {
  it('walks a straight line into one polyline end to end', () => {
    const mask = maskFromAscii(['......', '.####.', '......']);
    const lines = traceSkeleton(mask);
    expect(lines).toHaveLength(1);
    const xs = lines[0].map((p) => p.x);
    expect(Math.min(...xs)).toBe(1);
    expect(Math.max(...xs)).toBe(4);
    expect(lines[0]).toHaveLength(4);
  });

  it('traces an L shape as a single polyline through the corner', () => {
    const mask = maskFromAscii(['.#...', '.#...', '.####']);
    const lines = traceSkeleton(mask);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(6);
  });

  it('keeps separate marks as separate polylines', () => {
    const mask = maskFromAscii(['###.###']);
    const lines = traceSkeleton(mask);
    expect(lines).toHaveLength(2);
  });

  it('traces a closed loop and closes it back to the start', () => {
    const mask = maskFromAscii(['.###.', '.#.#.', '.###.']);
    const lines = traceSkeleton(mask);
    expect(lines).toHaveLength(1);
    const loop = lines[0];
    expect(loop[0]).toEqual(loop[loop.length - 1]);
    // All 8 ring pixels visited (+1 for the closing copy).
    expect(loop).toHaveLength(9);
  });

  it('drops isolated single pixels', () => {
    const mask = maskFromAscii(['#....', '..###']);
    const lines = traceSkeleton(mask);
    expect(lines).toHaveLength(1);
  });
});

describe('simplifyPolyline', () => {
  const line = (...pairs: Array<[number, number]>): PdfStrokePoint[] =>
    pairs.map(([x, y]) => ({ x, y }));

  it('collapses collinear runs to their endpoints', () => {
    const simplified = simplifyPolyline(
      line([0, 0], [1, 0], [2, 0], [3, 0], [4, 0]),
      0.5
    );
    expect(simplified).toEqual(line([0, 0], [4, 0]));
  });

  it('preserves a corner beyond the tolerance', () => {
    const simplified = simplifyPolyline(line([0, 0], [5, 0], [5, 5]), 0.5);
    expect(simplified).toEqual(line([0, 0], [5, 0], [5, 5]));
  });

  it('flattens pixel stair-steps within tolerance into a diagonal', () => {
    const simplified = simplifyPolyline(
      line([0, 0], [1, 0], [1, 1], [2, 1], [2, 2], [3, 2], [3, 3]),
      1.2
    );
    expect(simplified).toEqual(line([0, 0], [3, 3]));
  });

  it('keeps the far point of a closed loop despite a zero-length chord', () => {
    // First and last points coincide (a closed loop), so the chord has
    // zero length — distance falls back to point distance from the
    // shared endpoint instead of dividing by zero.
    const simplified = simplifyPolyline(line([0, 0], [3, 4], [0, 0]), 1);
    expect(simplified).toEqual(line([0, 0], [3, 4], [0, 0]));
  });
});

describe('attachMeasuredWidths', () => {
  it('samples the local ink width along the skeleton and smooths it', () => {
    // 5-tall block on the left, 1-tall tail on the right; skeleton runs
    // along the middle row.
    const mask = maskFromAscii([
      '#####.....',
      '#####.....',
      '##########',
      '#####.....',
      '#####.....'
    ]);
    const line: PdfStrokePoint[] = Array.from({ length: 10 }, (_, x) => ({
      x,
      y: 2
    }));
    const [withWidths] = attachMeasuredWidths([line], mask);
    // Thick end reads wider than the thin tail.
    expect(withWidths[0].pressure!).toBeGreaterThan(
      withWidths[9].pressure! * 1.5
    );
    // The tail is a 1px line → measured width ~1 (smoothing may blend
    // slightly near the block).
    expect(withWidths[9].pressure!).toBeLessThan(2);
  });
});

describe('fitToPad', () => {
  it('converts measured source widths into stroke width + relative pressure', () => {
    const [stroke] = fitToPad([
      [
        { x: 0, y: 0, pressure: 3 },
        { x: 100, y: 0, pressure: 1.5 },
        { x: 100, y: 50, pressure: 1.5 }
      ]
    ]);
    // Mean measured width 2 src px; fit scale for a 100×50 box into the
    // pad's 400×148 inner box is min(4, 2.96) = 2.96.
    const scale = (SIGNATURE_PAD_HEIGHT - 20) / 50;
    expect(stroke.width).toBeCloseTo(2 * scale, 5);
    expect(stroke.points[0].pressure).toBeCloseTo(1.5, 5);
    expect(stroke.points[1].pressure).toBeCloseTo(0.75, 5);
    expect(stroke.points[2].pressure).toBeCloseTo(0.75, 5);
  });

  it('keeps the uniform pad styling when points carry no measurement', () => {
    const [stroke] = fitToPad([
      [
        { x: 0, y: 0 },
        { x: 100, y: 50 }
      ]
    ]);
    expect(stroke.width).toBe(SIGNATURE_STROKE_WIDTH);
    expect(stroke.points.every((p) => p.pressure === 1)).toBe(true);
  });

  it('scales uniformly, centres, and stays inside the pad box', () => {
    const strokes = fitToPad([
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 50 }
      ]
    ]);
    expect(strokes).toHaveLength(1);
    for (const p of strokes[0].points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(SIGNATURE_PAD_WIDTH);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(SIGNATURE_PAD_HEIGHT);
    }
    // Uniform scale: the 2:1 aspect of the source is preserved.
    const [a, b, c] = strokes[0].points;
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(c.y - b.y);
    expect(w / h).toBeCloseTo(2, 5);
    // Centred vertically (width is the binding dimension here).
    expect((a.y + c.y) / 2).toBeCloseTo(SIGNATURE_PAD_HEIGHT / 2, 5);
  });

  it('returns no strokes for no input', () => {
    expect(fitToPad([])).toEqual([]);
  });
});

describe('traceSignature (end to end)', () => {
  // A scrawl with two separate marks, drawn 3px thick so thinning has
  // real work to do — roughly "J." at doodle scale.
  const photo = [
    '........................................',
    '.....###############....................',
    '.....###############....................',
    '.....###############....................',
    '..........###...........................',
    '..........###...........................',
    '..........###...........................',
    '..........###...........................',
    '..........###...........................',
    '..........###...........................',
    '..........###..................###......',
    '..........###..................###......',
    '.###......###..................###......',
    '.###......###...........................',
    '.############............................'.slice(0, 40),
    '..##########.............................'.slice(0, 40),
    '........................................'
  ];

  it('vectorises ink into pad-space strokes', () => {
    const result = traceSignature(rasterFromAscii(photo), {
      // The doodle is tiny; the area-relative default would eat it.
      minComponentSize: 4
    });
    expect(result.width).toBe(SIGNATURE_PAD_WIDTH);
    expect(result.height).toBe(SIGNATURE_PAD_HEIGHT);
    // The J and the dot: at least two distinct strokes survive.
    expect(result.strokes.length).toBeGreaterThanOrEqual(2);
    for (const stroke of result.strokes) {
      expect(stroke.points.length).toBeGreaterThanOrEqual(2);
      for (const p of stroke.points) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(SIGNATURE_PAD_WIDTH);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(SIGNATURE_PAD_HEIGHT);
      }
    }
    // The applied sensitivity is echoed back to seed the UI slider.
    expect(result.sensitivity).toBe(0.5);
  });

  it('returns zero strokes for a blank page', () => {
    const blank = Array.from({ length: 12 }, () => '.'.repeat(24));
    const result = traceSignature(rasterFromAscii(blank));
    expect(result.strokes).toEqual([]);
  });

  it('captures a taper as decreasing per-point pressure', () => {
    // Wedge: 7px tall at the left shrinking to 1px at the right.
    const width = 36;
    const rows = Array.from({ length: 9 }, (_, y) =>
      Array.from({ length: width }, (_, x) => {
        const half = 3 * (1 - x / (width - 1));
        return x < width - 2 && Math.abs(y - 4) <= half + 0.5 ? '#' : '.';
      }).join('')
    );
    const result = traceSignature(rasterFromAscii(rows), {
      minComponentSize: 4,
      borderBlobThickness: 0
    });
    expect(result.strokes).toHaveLength(1);
    const points = result.strokes[0].points;
    const first = points[0];
    const last = points[points.length - 1];
    // Thick end left, thin end right (or reversed walk order — compare
    // by x position).
    const [thick, thin] = first.x < last.x ? [first, last] : [last, first];
    expect(thick.pressure!).toBeGreaterThan(thin.pressure! * 1.5);
    // Mean-relative convention: pressures straddle 1.
    expect(thick.pressure!).toBeGreaterThan(1);
    expect(thin.pressure!).toBeLessThan(1);
  });

  it('drops a finger-like blob at the border but keeps the signature', () => {
    // Thin zig-zag stroke in the middle, fat slab hanging off the left
    // border (a finger gripping the paper). The slab is wide enough that
    // thinning leaves a traceable line, so the disabled-rejection control
    // proves the slab was removed by the rejection and not lost earlier.
    // The zig-zag starts beyond bridging distance of the slab so the
    // two stay separate components in both variants.
    const rows = [
      '########............',
      '########....##......',
      '########......##....',
      '########........##..',
      '....................'
    ];
    const withFinger = traceSignature(rasterFromAscii(rows), {
      minComponentSize: 4,
      borderBlobThickness: 1
    });
    expect(withFinger.strokes).toHaveLength(1);

    // Same scene with rejection disabled traces the slab too.
    const kept = traceSignature(rasterFromAscii(rows), {
      minComponentSize: 4,
      borderBlobThickness: 0
    });
    expect(kept.strokes.length).toBeGreaterThan(1);
  });

  it('picks up faint ink only at higher sensitivity', () => {
    // Pale pencil (220 on white 255): ~13% local contrast — below the
    // default 16% requirement, above the 2% at full sensitivity.
    const img: RasterImage = {
      width: 8,
      height: 3,
      data: new Uint8ClampedArray(8 * 3 * 4).fill(255)
    };
    for (let x = 1; x < 7; x++) {
      const o = (1 * 8 + x) * 4;
      img.data[o] = 220;
      img.data[o + 1] = 220;
      img.data[o + 2] = 220;
    }
    const dim = traceSignature(img, { sensitivity: 0.5, minComponentSize: 2 });
    const keen = traceSignature(img, { sensitivity: 1, minComponentSize: 2 });
    expect(dim.strokes).toEqual([]);
    expect(dim.sensitivity).toBe(0.5);
    expect(keen.strokes.length).toBeGreaterThan(0);
  });
});
