import { describe, expect, it } from 'vitest';
import type { RasterImage } from './signature-trace';
import {
  detectPaperQuad,
  downscaleRaster,
  maxAreaQuad,
  orderQuad,
  polygonArea,
  rectifyPaper,
  type PaperQuad,
  type QuadPoint
} from './paper-detect';

/**
 * Render a synthetic photo: dark scene, one bright convex quad (the
 * paper), optional dark marks on the paper and dark intrusions over its
 * edge (fingers).
 */
function renderScene(
  width: number,
  height: number,
  paper: QuadPoint[] | null,
  opts: {
    marks?: Array<{ x: number; y: number; r: number }>;
    fingers?: Array<{ x: number; y: number; r: number }>;
    paperLevel?: number;
    sceneLevel?: number;
  } = {}
): RasterImage {
  const { marks = [], fingers = [], paperLevel = 230, sceneLevel = 45 } = opts;
  const data = new Uint8ClampedArray(width * height * 4);
  const inQuad = (px: number, py: number, q: QuadPoint[]): boolean => {
    let sign = 0;
    for (let i = 0; i < q.length; i++) {
      const a = q[i];
      const b = q[(i + 1) % q.length];
      const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
      if (cross !== 0) {
        const s = Math.sign(cross);
        if (sign === 0) sign = s;
        else if (s !== sign) return false;
      }
    }
    return true;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = sceneLevel;
      if (paper && inQuad(x, y, paper)) {
        v = paperLevel;
        for (const mark of marks) {
          if (Math.hypot(x - mark.x, y - mark.y) < mark.r) v = 20;
        }
      }
      for (const finger of fingers) {
        if (Math.hypot(x - finger.x, y - finger.y) < finger.r) v = 90;
      }
      const o = (y * width + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Max distance between each expected corner and its nearest actual. */
function cornerError(actual: PaperQuad, expected: QuadPoint[]): number {
  let worst = 0;
  for (const e of expected) {
    let best = Infinity;
    for (const a of actual) {
      best = Math.min(best, Math.hypot(a.x - e.x, a.y - e.y));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

describe('polygonArea / orderQuad / maxAreaQuad', () => {
  it('computes shoelace area', () => {
    expect(
      polygonArea([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
        { x: 0, y: 5 }
      ])
    ).toBe(50);
  });

  it('orders corners TL, TR, BR, BL for any input order', () => {
    const quad = orderQuad([
      { x: 90, y: 80 },
      { x: 10, y: 10 },
      { x: 95, y: 15 },
      { x: 5, y: 85 }
    ]);
    expect(quad[0]).toEqual({ x: 10, y: 10 });
    expect(quad[1]).toEqual({ x: 95, y: 15 });
    expect(quad[2]).toEqual({ x: 90, y: 80 });
    expect(quad[3]).toEqual({ x: 5, y: 85 });
  });

  it('keeps a rotated (diamond) quad in valid cyclic order', () => {
    const quad = orderQuad([
      { x: 50, y: 0 },
      { x: 100, y: 50 },
      { x: 50, y: 100 },
      { x: 0, y: 50 }
    ]);
    // Cyclic order ⇔ full shoelace area (a "bowtie" ordering halves it).
    expect(polygonArea(quad)).toBeCloseTo(5000, 5);
  });

  it('finds the dominant quad among hull points', () => {
    const corners = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 }
    ];
    // Hull with midpoints sprinkled in — the corners still win.
    const hull = [
      corners[0],
      { x: 50, y: 0 },
      corners[1],
      { x: 100, y: 30 },
      corners[2],
      { x: 50, y: 60 },
      corners[3],
      { x: 0, y: 30 }
    ];
    const quad = maxAreaQuad(hull)!;
    expect(cornerError(quad, corners)).toBe(0);
  });
});

describe('detectPaperQuad', () => {
  const paper = [
    { x: 80, y: 40 },
    { x: 540, y: 70 },
    { x: 510, y: 380 },
    { x: 60, y: 330 }
  ];

  it('finds a tilted paper and returns corners in source coordinates', () => {
    const scene = renderScene(640, 480, paper);
    const quad = detectPaperQuad(scene);
    expect(quad).not.toBeNull();
    // Detection runs at 320px working width → allow a few source px.
    expect(cornerError(quad!, paper)).toBeLessThan(8);
  });

  it('still finds the paper when fingers overlap its edges', () => {
    const scene = renderScene(640, 480, paper, {
      fingers: [
        { x: 300, y: 55, r: 28 },
        { x: 70, y: 200, r: 26 }
      ]
    });
    const quad = detectPaperQuad(scene);
    expect(quad).not.toBeNull();
    expect(cornerError(quad!, paper)).toBeLessThan(12);
  });

  it('returns null when there is no paper', () => {
    expect(detectPaperQuad(renderScene(320, 240, null))).toBeNull();
  });

  it('returns null when the bright region is too small', () => {
    const tiny = [
      { x: 150, y: 110 },
      { x: 190, y: 110 },
      { x: 190, y: 140 },
      { x: 150, y: 140 }
    ];
    expect(detectPaperQuad(renderScene(640, 480, tiny))).toBeNull();
  });

  it('returns null when the paper fills the whole frame', () => {
    const full = [
      { x: -10, y: -10 },
      { x: 650, y: -10 },
      { x: 650, y: 490 },
      { x: -10, y: 490 }
    ];
    expect(detectPaperQuad(renderScene(640, 480, full))).toBeNull();
  });

  it('returns null for a non-quadrilateral bright shape', () => {
    // L-shaped bright region: low solidity vs its hull.
    const scene = renderScene(640, 480, null);
    for (let y = 40; y < 440; y++) {
      for (let x = 40; x < 600; x++) {
        const inL = x < 200 || y > 320;
        if (!inL) continue;
        const o = (y * 640 + x) * 4;
        scene.data[o] = 230;
        scene.data[o + 1] = 230;
        scene.data[o + 2] = 230;
      }
    }
    expect(detectPaperQuad(scene)).toBeNull();
  });
});

describe('rectifyPaper', () => {
  it('warps the paper fronto-parallel with the mark where expected', () => {
    const paper = [
      { x: 80, y: 40 },
      { x: 540, y: 70 },
      { x: 510, y: 380 },
      { x: 60, y: 330 }
    ];
    // Mark at the paper's centroid.
    const cx = (80 + 540 + 510 + 60) / 4;
    const cy = (40 + 70 + 380 + 330) / 4;
    const scene = renderScene(640, 480, paper, {
      marks: [{ x: cx, y: cy, r: 18 }]
    });
    const quad = detectPaperQuad(scene)!;
    const out = rectifyPaper(scene, quad, { maxDim: 400 });

    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(400);
    const px = (x: number, y: number) => out.data[(y * out.width + x) * 4];
    // Centre: the dark mark. Corners: paper white (shadow inset means we
    // never sample the dark scene).
    expect(
      px(Math.round(out.width / 2), Math.round(out.height / 2))
    ).toBeLessThan(60);
    expect(px(3, 3)).toBeGreaterThan(180);
    expect(px(out.width - 4, 3)).toBeGreaterThan(180);
    expect(px(3, out.height - 4)).toBeGreaterThan(180);
    expect(px(out.width - 4, out.height - 4)).toBeGreaterThan(180);
  });

  it('preserves the quad aspect ratio in the output', () => {
    const paper = [
      { x: 100, y: 100 },
      { x: 500, y: 100 },
      { x: 500, y: 300 },
      { x: 100, y: 300 }
    ];
    const scene = renderScene(640, 480, paper);
    const out = rectifyPaper(scene, detectPaperQuad(scene)!, { maxDim: 800 });
    // 400×200 paper → 2:1 output (inset applies to both axes equally).
    expect(out.width / out.height).toBeCloseTo(2, 1);
  });
});

describe('downscaleRaster', () => {
  it('caps the longer side and preserves aspect', () => {
    const raster = renderScene(800, 400, null);
    const small = downscaleRaster(raster, 200);
    expect(small.width).toBe(200);
    expect(Math.abs(small.height - 100)).toBeLessThanOrEqual(1);
  });

  it('returns the input untouched when already small enough', () => {
    const raster = renderScene(100, 80, null);
    expect(downscaleRaster(raster, 200)).toBe(raster);
  });
});
