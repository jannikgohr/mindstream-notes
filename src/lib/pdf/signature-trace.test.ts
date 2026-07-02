import { describe, expect, it } from 'vitest';
import type { PdfStrokePoint } from './types';
import {
  binarize,
  fitToPad,
  luminance,
  otsuThreshold,
  removeSpecks,
  simplifyPolyline,
  thin,
  traceSignature,
  traceSkeleton,
  SIGNATURE_PAD_HEIGHT,
  SIGNATURE_PAD_WIDTH,
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

describe('binarize', () => {
  it('marks dark pixels as ink', () => {
    const img = rasterFromAscii(['#..', '.#.']);
    const mask = binarize(luminance(img), 3, 2, 127);
    expect(Array.from(mask.data)).toEqual([1, 0, 0, 0, 1, 0]);
  });

  it('auto-inverts light-on-dark input', () => {
    // White signature stroke on a black background: the dark side is
    // the majority, so the mask must flip to keep ink the minority.
    const img = rasterFromAscii(['###', '#.#', '###']);
    const mask = binarize(luminance(img), 3, 3, 127);
    expect(Array.from(mask.data)).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 0]);
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
});

describe('fitToPad', () => {
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
    // Otsu on a black/white image lands between the two levels.
    expect(result.threshold).toBeGreaterThanOrEqual(0);
    expect(result.threshold).toBeLessThan(255);
  });

  it('returns zero strokes for a blank page', () => {
    const blank = Array.from({ length: 12 }, () => '.'.repeat(24));
    const result = traceSignature(rasterFromAscii(blank));
    expect(result.strokes).toEqual([]);
  });

  it('respects an explicit threshold override', () => {
    // Mid-gray ink (128): invisible with a low threshold, ink with a
    // high one.
    const img: RasterImage = {
      width: 8,
      height: 3,
      data: new Uint8ClampedArray(8 * 3 * 4).fill(255)
    };
    for (let x = 1; x < 7; x++) {
      const o = (1 * 8 + x) * 4;
      img.data[o] = 128;
      img.data[o + 1] = 128;
      img.data[o + 2] = 128;
    }
    const low = traceSignature(img, { threshold: 60, minComponentSize: 2 });
    const high = traceSignature(img, { threshold: 200, minComponentSize: 2 });
    expect(low.strokes).toEqual([]);
    expect(low.threshold).toBe(60);
    expect(high.strokes.length).toBeGreaterThan(0);
  });
});
