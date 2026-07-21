import { describe, expect, it } from 'vitest';
import {
  drawPageBackground,
  drawPages,
  drawStroke,
  visiblePageBounds,
  type InkScene
} from './canvas-painter';
import { defaultLayout } from './page';
import { defaultView, type InkView } from './view-transform';
import type { InkPoint } from './page';

type Call = { op: string; args: unknown[] };

/**
 * A 2D context that records what was asked of it. The painters are pure
 * command streams over the canvas API, so the recording is the output.
 */
function recordingContext() {
  const calls: Call[] = [];
  const set: Record<string, unknown> = {};
  const target: Record<string, unknown> = {};
  for (const op of [
    'save',
    'restore',
    'beginPath',
    'clip',
    'rect',
    'fill',
    'fillRect',
    'strokeRect',
    'stroke',
    'arc',
    'moveTo',
    'lineTo'
  ]) {
    target[op] = (...args: unknown[]) => calls.push({ op, args });
  }
  const ctx = new Proxy(target, {
    set(_t, prop, value) {
      set[String(prop)] = value;
      return true;
    },
    get(t, prop) {
      return t[String(prop)] ?? set[String(prop)];
    }
  }) as unknown as CanvasRenderingContext2D;
  return {
    ctx,
    calls,
    set,
    count: (op: string) => calls.filter((c) => c.op === op).length
  };
}

const layout = defaultLayout();
const view: InkView = {
  ...defaultView(),
  width: 1000,
  height: 800,
  scale: 1,
  panX: 0,
  panY: 0
};

function scene(overrides: Partial<InkScene> = {}): InkScene {
  return {
    view,
    layout,
    pageDark: false,
    pageBackground: 'clear',
    pageBackgroundColorRgb: 0x000000,
    pageBackgroundOpacity: 1,
    displayCssColor: (argb) => `argb(${argb})`,
    ...overrides
  };
}

function points(...pairs: Array<[number, number, number?]>): InkPoint[] {
  return pairs.map(([x, y, pressure]) => ({ x, y, pressure: pressure ?? 0.5 }));
}

describe('visiblePageBounds', () => {
  it('is the window expressed in page coordinates', () => {
    expect(
      visiblePageBounds({ ...view, scale: 2, panX: -100, panY: -200 })
    ).toEqual({ minX: 50, minY: 100, maxX: 550, maxY: 500 });
  });
});

describe('drawPages', () => {
  it('paints only the pages inside the visible band', () => {
    const rec = recordingContext();
    // A tall band covering the first page only.
    drawPages(rec.ctx, { minX: 0, minY: 0, maxX: 600, maxY: 100 }, scene());

    // One sheet fill + one edge stroke per painted page.
    expect(rec.count('fillRect')).toBeGreaterThanOrEqual(1);
    expect(rec.count('fillRect')).toBe(rec.count('strokeRect'));
  });

  it('paints nothing when the band is past the last page', () => {
    const rec = recordingContext();
    const farBelow = 1e6;
    drawPages(
      rec.ctx,
      { minX: 0, minY: farBelow, maxX: 600, maxY: farBelow + 100 },
      scene()
    );

    expect(rec.count('fillRect')).toBe(0);
  });

  it('asks the scene to translate every colour it paints', () => {
    const seen: number[] = [];
    const rec = recordingContext();
    drawPages(
      rec.ctx,
      { minX: 0, minY: 0, maxX: 600, maxY: 100 },
      scene({
        displayCssColor: (argb) => {
          seen.push(argb);
          return '#fff';
        }
      })
    );
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe('drawPageBackground', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 600, y: 800 };

  it('draws nothing for a clear page', () => {
    const rec = recordingContext();
    drawPageBackground(rec.ctx, a, b, scene({ pageBackground: 'clear' }));
    expect(rec.calls).toHaveLength(0);
  });

  it('draws dots for a dotted page', () => {
    const rec = recordingContext();
    drawPageBackground(rec.ctx, a, b, scene({ pageBackground: 'points' }));
    expect(rec.count('arc')).toBeGreaterThan(0);
  });

  it('draws only horizontal rules for a lined page', () => {
    const rec = recordingContext();
    drawPageBackground(rec.ctx, a, b, scene({ pageBackground: 'lines' }));
    const horizontal = rec.calls.filter((c) => c.op === 'moveTo');
    expect(horizontal.length).toBeGreaterThan(0);
    // Every rule starts at the left page edge.
    expect(horizontal.every((c) => c.args[0] === a.x)).toBe(true);
  });

  it('adds vertical rules for a grid page', () => {
    const lined = recordingContext();
    drawPageBackground(lined.ctx, a, b, scene({ pageBackground: 'lines' }));
    const grid = recordingContext();
    drawPageBackground(grid.ctx, a, b, scene({ pageBackground: 'grid' }));

    expect(grid.count('moveTo')).toBeGreaterThan(lined.count('moveTo'));
  });

  it('skips the pattern when zoomed out far enough to smear it', () => {
    const rec = recordingContext();
    drawPageBackground(
      rec.ctx,
      a,
      b,
      scene({ pageBackground: 'grid', view: { ...view, scale: 0.001 } })
    );
    expect(rec.count('moveTo')).toBe(0);
  });

  it('skips the pattern when it is fully transparent', () => {
    const rec = recordingContext();
    drawPageBackground(
      rec.ctx,
      a,
      b,
      scene({ pageBackground: 'points', pageBackgroundOpacity: 0 })
    );
    expect(rec.count('arc')).toBe(0);
  });

  it('always balances save with restore', () => {
    for (const background of ['points', 'lines', 'grid'] as const) {
      const rec = recordingContext();
      drawPageBackground(rec.ctx, a, b, scene({ pageBackground: background }));
      expect(rec.count('save')).toBe(rec.count('restore'));
    }
  });

  it('balances save/restore on the early-out paths too', () => {
    const rec = recordingContext();
    drawPageBackground(
      rec.ctx,
      a,
      b,
      scene({ pageBackground: 'points', pageBackgroundOpacity: 0 })
    );
    expect(rec.count('save')).toBe(rec.count('restore'));
  });
});

describe('drawStroke', () => {
  it('ignores a stroke with fewer than two points', () => {
    const rec = recordingContext();
    drawStroke(rec.ctx, points([0, 0]), '#000', 4, view);
    expect(rec.calls).toHaveLength(0);
  });

  it('draws a segment per point pair', () => {
    const rec = recordingContext();
    drawStroke(rec.ctx, points([0, 0], [10, 10], [20, 20]), '#000', 4, view);
    expect(rec.count('lineTo')).toBe(2);
    expect(rec.count('stroke')).toBeGreaterThanOrEqual(1);
  });

  it('applies pan and scale to the painted coordinates', () => {
    const rec = recordingContext();
    const panned = { ...view, scale: 2, panX: 100, panY: 50 };
    drawStroke(rec.ctx, points([0, 0], [10, 10]), '#000', 4, panned);

    expect(rec.calls.find((c) => c.op === 'moveTo')?.args).toEqual([100, 50]);
    expect(rec.calls.find((c) => c.op === 'lineTo')?.args).toEqual([120, 70]);
  });

  it('reuses one path while the width is unchanged', () => {
    const rec = recordingContext();
    const flat = points([0, 0, 0.5], [10, 0, 0.5], [20, 0, 0.5], [30, 0, 0.5]);
    drawStroke(rec.ctx, flat, '#000', 4, view);

    // Constant pressure means one quantised width, so one path.
    expect(rec.count('beginPath')).toBe(1);
  });

  it('starts a new path when pressure changes the width', () => {
    const rec = recordingContext();
    // Each segment's width comes from the mean pressure of its endpoints,
    // so the pressures must ramp rather than peak — a symmetric peak gives
    // both segments the same mean and legitimately stays one path.
    const varying = points([0, 0, 0.1], [10, 0, 0.1], [20, 0, 1]);
    drawStroke(rec.ctx, varying, '#000', 20, view);

    expect(rec.count('beginPath')).toBeGreaterThan(1);
  });

  it('keeps one path when a symmetric pressure peak averages out', () => {
    const rec = recordingContext();
    const peak = points([0, 0, 0.1], [10, 0, 1], [20, 0, 0.1]);
    drawStroke(rec.ctx, peak, '#000', 20, view);

    expect(rec.count('beginPath')).toBe(1);
  });

  it('never paints a hairline thinner than one pixel', () => {
    const rec = recordingContext();
    drawStroke(rec.ctx, points([0, 0], [10, 10]), '#000', 0.0001, {
      ...view,
      scale: 0.01
    });
    expect(rec.set.lineWidth).toBeGreaterThanOrEqual(1);
  });
});
