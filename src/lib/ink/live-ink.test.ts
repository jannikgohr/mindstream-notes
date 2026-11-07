import { describe, expect, it } from 'vitest';
import { liveInkStyle } from './live-ink';
import { displayColor, pressureWidth } from './editor-helpers';

const base = {
  colorArgb: 0xff112233,
  width: 4,
  scale: 2,
  devicePixelRatio: 2.5,
  pageDark: false,
  onBackgroundPage: false
};

describe('liveInkStyle', () => {
  it('sends widths in surface pixels matching the canvas at every pressure', () => {
    const style = liveInkStyle(base);
    for (const pressure of [0, 0.3, 1]) {
      const overlay =
        style.minWidthPx + (style.maxWidthPx - style.minWidthPx) * pressure;
      const canvasCss = Math.max(1, 4 * 2 * pressureWidth(pressure));
      expect(overlay).toBeCloseTo(canvasCss * 2.5);
    }
  });

  it('keeps the canvas one-pixel floor for hairlines', () => {
    const style = liveInkStyle({ ...base, width: 1, scale: 0.5 });
    expect(style.minWidthPx).toBeCloseTo(2.5);
    expect(style.maxWidthPx).toBeCloseTo(2.5);
  });

  it('paints the colour the canvas will show for the page under the pen', () => {
    expect(liveInkStyle(base).colorArgb).toBe(0xff112233);
    expect(liveInkStyle({ ...base, pageDark: true }).colorArgb).toBe(
      displayColor(0xff112233, true)
    );
    expect(
      liveInkStyle({ ...base, pageDark: true, onBackgroundPage: true })
        .colorArgb
    ).toBe(0xff112233);
  });
});
