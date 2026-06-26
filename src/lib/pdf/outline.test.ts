import { describe, expect, it, vi } from 'vitest';
import { loadFlatOutline, resolveDestinationPageIndex } from './outline';

/**
 * Minimal stand-in for the slice of pdf.js's PDFDocumentProxy the outline
 * loader touches. Only the three methods it calls are implemented.
 */
type FakeDoc = Parameters<typeof loadFlatOutline>[0];

const makeDoc = (overrides: Partial<Record<keyof FakeDoc, unknown>>): FakeDoc =>
  overrides as unknown as FakeDoc;

const REF = { num: 1, gen: 0 };

describe('resolveDestinationPageIndex', () => {
  it('returns null when the destination is null or undefined', async () => {
    const doc = makeDoc({});
    expect(await resolveDestinationPageIndex(doc, null)).toBeNull();
    expect(await resolveDestinationPageIndex(doc, undefined)).toBeNull();
  });

  it('resolves an explicit destination array to a page index', async () => {
    const doc = makeDoc({
      getPageIndex: vi.fn().mockResolvedValue(4)
    });
    expect(await resolveDestinationPageIndex(doc, [REF, 'XYZ'])).toBe(4);
  });

  it('resolves a named destination via getDestination', async () => {
    const getDestination = vi.fn().mockResolvedValue([REF]);
    const getPageIndex = vi.fn().mockResolvedValue(2);
    const doc = makeDoc({ getDestination, getPageIndex });
    expect(await resolveDestinationPageIndex(doc, 'chapter-1')).toBe(2);
    expect(getDestination).toHaveBeenCalledWith('chapter-1');
  });

  it('returns null when the named destination cannot be resolved', async () => {
    const doc = makeDoc({
      getDestination: vi.fn().mockResolvedValue(null)
    });
    expect(await resolveDestinationPageIndex(doc, 'missing')).toBeNull();
  });

  it('returns null for an empty destination array', async () => {
    const doc = makeDoc({});
    expect(await resolveDestinationPageIndex(doc, [])).toBeNull();
  });

  it('returns null when the first ref is not an object', async () => {
    const doc = makeDoc({ getPageIndex: vi.fn() });
    expect(await resolveDestinationPageIndex(doc, ['not-a-ref'])).toBeNull();
  });

  it('swallows errors from getPageIndex and returns null', async () => {
    const doc = makeDoc({
      getPageIndex: vi.fn().mockRejectedValue(new Error('boom'))
    });
    expect(await resolveDestinationPageIndex(doc, [REF])).toBeNull();
  });
});

describe('loadFlatOutline', () => {
  it('returns an empty array when the PDF has no outline', async () => {
    const doc = makeDoc({ getOutline: vi.fn().mockResolvedValue(null) });
    expect(await loadFlatOutline(doc)).toEqual([]);
  });

  it('returns an empty array when getOutline throws', async () => {
    const doc = makeDoc({
      getOutline: vi.fn().mockRejectedValue(new Error('no outline'))
    });
    expect(await loadFlatOutline(doc)).toEqual([]);
  });

  it('flattens a nested outline with depth and resolved page indices', async () => {
    const doc = makeDoc({
      getOutline: vi.fn().mockResolvedValue([
        {
          title: 'Chapter 1',
          dest: [REF],
          items: [{ title: 'Section 1.1', dest: [REF], items: [] }]
        },
        { title: 'Chapter 2', dest: [REF], items: [] }
      ]),
      getPageIndex: vi
        .fn()
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(5)
    });

    const out = await loadFlatOutline(doc);
    expect(out).toEqual([
      { id: 'outline-0', title: 'Chapter 1', depth: 0, pageIndex: 0 },
      { id: 'outline-1', title: 'Section 1.1', depth: 1, pageIndex: 1 },
      { id: 'outline-2', title: 'Chapter 2', depth: 0, pageIndex: 5 }
    ]);
  });

  it('falls back to an ellipsis title for blank entries', async () => {
    const doc = makeDoc({
      getOutline: vi
        .fn()
        .mockResolvedValue([{ title: '   ', dest: null, items: [] }])
    });
    const out = await loadFlatOutline(doc);
    expect(out[0].title).toBe('…');
    expect(out[0].pageIndex).toBeNull();
  });
});
