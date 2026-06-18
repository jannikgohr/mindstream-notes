import { describe, expect, it } from 'vitest';
import {
  A4_PAGE,
  PAGE_FIT_MARGIN,
  PAGE_FIT_TOP_MARGIN,
  PAGE_SURFACE_CLASS,
  PAGE_SCROLLER_CLASS,
  PAGE_SCROLLER_SCROLLBAR_CLASS,
  PAGE_COLUMN_CLASS,
  canvasPageSurface
} from './page-layout';

describe('page-layout', () => {
  it('keeps the ink page A4, 1:1 with the PDF viewer', () => {
    // 1190×1684 is exactly 2× PDF.js's 595×842 pt A4 page, so an ink
    // page and an A4 PDF page frame identically.
    expect(A4_PAGE.width).toBe(595 * 2);
    expect(A4_PAGE.height).toBe(842 * 2);
    // ...and holds the A4 aspect ratio (within the 595×842 rounding).
    expect(A4_PAGE.height / A4_PAGE.width).toBeCloseTo(297 / 210, 2);
  });

  it('keeps fit margins positive and leaves more room at the top', () => {
    expect(PAGE_FIT_MARGIN).toBeGreaterThan(0);
    expect(PAGE_FIT_TOP_MARGIN).toBeGreaterThanOrEqual(PAGE_FIT_MARGIN);
  });

  it('exposes the DOM page surface as shadow + ring on a white sheet', () => {
    expect(PAGE_SURFACE_CLASS).toContain('bg-white');
    expect(PAGE_SURFACE_CLASS).toContain('shadow');
    expect(PAGE_SURFACE_CLASS).toContain('ring');
  });

  it('gaps the page column and leaves horizontal insets to the fit gutter', () => {
    expect(PAGE_SCROLLER_CLASS).toMatch(/py-\d/);
    // No horizontal padding on the scroller — the side gutter is the
    // fit margin, so the page can be centred against the full width.
    expect(PAGE_SCROLLER_CLASS).not.toMatch(/px-\d/);
    expect(PAGE_COLUMN_CLASS).toMatch(/gap-\d/);
  });

  it('overlays the page scrollbar so it never steals width', () => {
    // A hidden-footprint scrollbar keeps the page full-width + centred
    // regardless of page count; both gutters then split one scrollbar.
    expect(PAGE_SCROLLER_SCROLLBAR_CLASS).toContain('scrollbar-none');
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
