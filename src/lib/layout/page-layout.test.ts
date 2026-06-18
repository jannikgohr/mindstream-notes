import { describe, expect, it } from 'vitest';
import {
  PAGE_FIT_MARGIN,
  PAGE_FIT_TOP_MARGIN,
  PAGE_SURFACE_CLASS,
  PAGE_SCROLLER_CLASS,
  PAGE_COLUMN_CLASS,
  canvasPageSurface
} from './page-layout';

describe('page-layout', () => {
  it('keeps fit margins positive and leaves more room at the top', () => {
    expect(PAGE_FIT_MARGIN).toBeGreaterThan(0);
    expect(PAGE_FIT_TOP_MARGIN).toBeGreaterThanOrEqual(PAGE_FIT_MARGIN);
  });

  it('exposes the DOM page surface as shadow + ring on a white sheet', () => {
    expect(PAGE_SURFACE_CLASS).toContain('bg-white');
    expect(PAGE_SURFACE_CLASS).toContain('shadow');
    expect(PAGE_SURFACE_CLASS).toContain('ring');
  });

  it('pads the scroller and gaps the page column', () => {
    expect(PAGE_SCROLLER_CLASS).toMatch(/px-\d/);
    expect(PAGE_SCROLLER_CLASS).toMatch(/py-\d/);
    expect(PAGE_COLUMN_CLASS).toMatch(/gap-\d/);
  });

  it('returns distinct canvas surface tokens per theme', () => {
    const light = canvasPageSurface(false);
    const dark = canvasPageSurface(true);
    expect(light).not.toEqual(dark);
    // Dark pages lean on a stronger shadow than light ones.
    expect(dark.shadowBlur).toBeGreaterThan(light.shadowBlur);
    for (const surface of [light, dark]) {
      expect(surface.shadowBlur).toBeGreaterThan(0);
      expect(surface.shadowColor).toMatch(/^rgba\(/);
      expect(surface.edgeColor).toMatch(/^rgba\(/);
    }
  });
});
