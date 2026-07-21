import { describe, expect, it } from 'vitest';
import {
  clampScale,
  clampView,
  defaultView,
  displayInkZoom,
  fitWidthScale,
  fitWidthView,
  minScale,
  pageToScreen,
  scaleFromDisplayInkZoom,
  screenToPage,
  zoomAroundPoint,
  zoomToScale
} from './view-transform';
import { defaultLayout } from './page';
import type { InkView } from './view-transform';

const layout = defaultLayout();
const desktop: InkView = {
  ...defaultView(),
  width: 1200,
  height: 900,
  scale: 1,
  panX: 0,
  panY: 0
};
const fit = { mobileToolbar: false };

describe('coordinate conversion', () => {
  it('round-trips a point through screen and back', () => {
    const view = { ...desktop, scale: 1.7, panX: 42, panY: -13 };
    const page = { x: 123.5, y: 456.25 };

    const back = screenToPage(
      view,
      pageToScreen(view, page).x,
      pageToScreen(view, page).y
    );

    expect(back.x).toBeCloseTo(page.x, 6);
    expect(back.y).toBeCloseTo(page.y, 6);
  });

  it('accounts for pan and scale', () => {
    const view = { ...desktop, scale: 2, panX: 100, panY: 50 };
    expect(pageToScreen(view, { x: 10, y: 10 })).toEqual({ x: 120, y: 70 });
    const page = screenToPage(view, 120, 70);
    expect(page.x).toBeCloseTo(10);
    expect(page.y).toBeCloseTo(10);
  });
});

describe('display zoom', () => {
  it('round-trips through the display factor', () => {
    expect(scaleFromDisplayInkZoom(displayInkZoom(0.83))).toBeCloseTo(0.83);
  });
});

describe('minScale', () => {
  it('never goes below the absolute floor, however small the window', () => {
    const tiny = { ...desktop, width: 1, height: 1 };
    expect(minScale(tiny, layout)).toBeGreaterThanOrEqual(0.05);
  });

  it('is driven by whichever axis is more constrained', () => {
    const wide = { ...desktop, width: 4000, height: 400 };
    const tall = { ...desktop, width: 300, height: 4000 };
    // A short, wide window is limited by height; a narrow one by width.
    expect(minScale(wide, layout)).toBeLessThan(minScale(tall, layout) * 100);
    expect(minScale(wide, layout)).toBeGreaterThan(0);
  });
});

describe('fitWidthScale', () => {
  it('makes the page span the window width minus the gutters', () => {
    const scale = fitWidthScale(desktop, layout);
    expect(layout.page.width * scale).toBeCloseTo(desktop.width - 32);
  });

  it('is never below minScale', () => {
    const squat = { ...desktop, width: 2000, height: 200 };
    expect(fitWidthScale(squat, layout)).toBeGreaterThanOrEqual(
      minScale(squat, layout)
    );
  });
});

describe('clampView', () => {
  it('centres content narrower than the window', () => {
    const zoomedOut = clampView(
      { ...desktop, scale: minScale(desktop, layout) },
      layout,
      fit
    );
    const contentW = layout.page.width * zoomedOut.scale;
    expect(zoomedOut.panX).toBeCloseTo((desktop.width - contentW) / 2);
  });

  it('refuses a scale below the fit-to-screen minimum', () => {
    const clamped = clampView({ ...desktop, scale: 0.0001 }, layout, fit);
    expect(clamped.scale).toBeCloseTo(minScale(desktop, layout));
  });

  it('keeps a wide page inside its pan limits', () => {
    const wide = { ...desktop, scale: 5, panX: 10_000 };
    const clamped = clampView(wide, layout, fit);
    expect(clamped.panX).toBeLessThanOrEqual(16);

    const farLeft = clampView({ ...wide, panX: -10_000 }, layout, fit);
    const contentW = layout.page.width * farLeft.scale;
    expect(farLeft.panX).toBeGreaterThanOrEqual(desktop.width - contentW - 16);
  });

  it('leaves more room at the top when the mobile toolbar overlays', () => {
    const scrolledUp = { ...desktop, scale: 3, panY: 10_000 };
    const plain = clampView(scrolledUp, layout, { mobileToolbar: false });
    const mobile = clampView(scrolledUp, layout, { mobileToolbar: true });
    expect(mobile.panY).toBeGreaterThanOrEqual(plain.panY);
  });

  it('does not disturb the window size', () => {
    const clamped = clampView(desktop, layout, fit);
    expect(clamped.width).toBe(desktop.width);
    expect(clamped.height).toBe(desktop.height);
  });
});

describe('fitWidthView', () => {
  it('lands on the fit-width scale', () => {
    const fitted = fitWidthView(desktop, layout, fit);
    expect(fitted.scale).toBeCloseTo(fitWidthScale(desktop, layout));
  });

  it('is idempotent', () => {
    const once = fitWidthView(desktop, layout, fit);
    const twice = fitWidthView(once, layout, fit);
    expect(twice).toEqual(once);
  });
});

describe('clampScale', () => {
  it('bounds zoom between fit-to-screen and the maximum factor', () => {
    const min = minScale(desktop, layout);
    expect(clampScale(desktop, layout, 0)).toBeCloseTo(min);
    expect(clampScale(desktop, layout, 1e6)).toBeGreaterThan(min);
    expect(clampScale(desktop, layout, 1e6)).toBeLessThanOrEqual(min * 8);
  });
});

describe('zoomAroundPoint', () => {
  it('keeps the anchored page point under the same screen point', () => {
    const view = { ...desktop, scale: 1, panX: 30, panY: 40 };
    const anchor = { x: 500, y: 300 };
    const pageUnderAnchor = screenToPage(view, anchor.x, anchor.y);

    const zoomed = zoomAroundPoint(view, layout, anchor.x, anchor.y, 2);
    const after = pageToScreen(zoomed, pageUnderAnchor);

    expect(after.x).toBeCloseTo(anchor.x, 6);
    expect(after.y).toBeCloseTo(anchor.y, 6);
  });

  it('still anchors when the requested scale is clamped', () => {
    const view = { ...desktop, scale: 1, panX: 0, panY: 0 };
    const pageUnderAnchor = screenToPage(view, 200, 200);

    const zoomed = zoomAroundPoint(view, layout, 200, 200, 1e6);
    const after = pageToScreen(zoomed, pageUnderAnchor);

    expect(after.x).toBeCloseTo(200, 6);
    expect(after.y).toBeCloseTo(200, 6);
  });
});

describe('zoomToScale', () => {
  it('anchors on the middle of the window', () => {
    const view = { ...desktop, scale: 1, panX: 0, panY: 0 };
    const centre = { x: view.width / 2, y: view.height / 2 };
    const pageUnderCentre = screenToPage(view, centre.x, centre.y);

    const zoomed = zoomToScale(view, layout, 2, fit);

    // Horizontally the content is narrower than the window at this scale,
    // so clamping centres it; vertically the anchor is preserved.
    const after = pageToScreen(zoomed, pageUnderCentre);
    expect(after.y).toBeCloseTo(centre.y, 6);
  });

  it('produces a viewport that is already clamped', () => {
    const zoomed = zoomToScale(desktop, layout, 3, fit);
    expect(clampView(zoomed, layout, fit)).toEqual(zoomed);
  });
});
