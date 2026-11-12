import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import type { Diagnostic } from '$lib/diagnostics/types';
import { sourceDiagnostics, splitParagraphs } from './diagnostics';

/**
 * Segmentation for the source surface. The invariant that matters is the
 * same one the prose plugin has to hold: `from` must be the exact offset of
 * the segment's first character, because a provider's in-segment position is
 * added straight to it. A one-character drift puts every squiggle in the
 * paragraph on the wrong word.
 */
const roundTrips = (text: string) =>
  splitParagraphs(text).every((s) => text.slice(s.from, s.to) === s.text);

describe('splitParagraphs', () => {
  it('returns one segment for a single paragraph', () => {
    expect(splitParagraphs('one line')).toEqual([
      { text: 'one line', from: 0, to: 8 }
    ]);
  });

  it('splits on a blank line', () => {
    expect(splitParagraphs('first\n\nsecond').map((s) => s.text)).toEqual([
      'first',
      'second'
    ]);
  });

  it('keeps wrapped lines in one segment', () => {
    // A sentence split across two lines must stay one segment, or a grammar
    // checker sees two fragments instead of a sentence.
    expect(
      splitParagraphs('a sentence\nwrapped here').map((s) => s.text)
    ).toEqual(['a sentence\nwrapped here']);
  });

  it('anchors every segment at its own offset', () => {
    const text = 'first\n\nsecond\n\nthird';
    expect(splitParagraphs(text).map((s) => s.from)).toEqual([0, 7, 15]);
    expect(roundTrips(text)).toBe(true);
  });

  it('round-trips through blank lines of varying width', () => {
    const text = 'a\n\n\n\nb\n \nc';
    expect(roundTrips(text)).toBe(true);
    expect(splitParagraphs(text).map((s) => s.text)).toEqual(['a', 'b', 'c']);
  });

  it('treats a whitespace-only line as a separator', () => {
    expect(splitParagraphs('a\n   \nb').map((s) => s.text)).toEqual(['a', 'b']);
  });

  it('ignores leading and trailing blank lines', () => {
    const text = '\n\nbody\n\n';
    expect(splitParagraphs(text).map((s) => s.text)).toEqual(['body']);
    expect(roundTrips(text)).toBe(true);
  });

  it('returns nothing for empty or blank input', () => {
    expect(splitParagraphs('')).toEqual([]);
    expect(splitParagraphs('\n\n  \n')).toEqual([]);
  });

  it('round-trips a realistic note', () => {
    const text = [
      '# Titel',
      '',
      'Ein Absatz mit einem',
      'Zeilenumbruch.',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      'Letzter Absatz.'
    ].join('\n');
    expect(roundTrips(text)).toBe(true);
  });
});

describe('source lifecycle', () => {
  let view: EditorView;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    view?.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const finding: Diagnostic = {
    from: 0,
    to: 3,
    kind: 'spelling',
    source: 'test',
    message: 'word',
    replacements: []
  };
  const marks = () =>
    [...view.dom.querySelectorAll('.cm-diagnostic')].map(
      (mark) => mark.textContent
    );

  it('maps partial and final results through edits during preparation and masks ignored text', async () => {
    let prepare!: (ranges: { from: number; to: number }[]) => void;
    let finish!: (results: Diagnostic[]) => void;
    let partial!: (results: Diagnostic[]) => void;
    const ignoreRanges = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            prepare = resolve;
          })
      )
      .mockResolvedValue([]);
    const check = vi.fn((_segments, _signal, onPartial) => {
      partial = onPartial;
      return new Promise<Diagnostic[]>((resolve) => {
        finish = resolve;
      });
    });
    view = new EditorView({
      doc: 'bad secret',
      extensions: [
        sourceDiagnostics({
          check,
          syntax: { id: 'plain', ignoreRanges, segment: splitParagraphs },
          debounceMs: 400
        })
      ]
    });
    await vi.advanceTimersByTimeAsync(0);
    view.dispatch({ changes: { from: 0, insert: 'X ' } });
    prepare([{ from: 4, to: 10 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(check.mock.calls[0][0][0].text).not.toContain('secret');
    partial([finding, { ...finding, from: 4, to: 10 }]);
    expect(marks()).toEqual(['bad']);
    finish([finding]);
    await vi.advanceTimersByTimeAsync(0);
    expect(marks()).toEqual(['bad']);
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('recovers rejected preparation and clears immediately on disabled invalidation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let invalidate!: () => void;
    let enabled = true;
    let finish!: (results: Diagnostic[]) => void;
    const ignoreRanges = vi
      .fn()
      .mockRejectedValueOnce(new Error('syntax'))
      .mockResolvedValue([]);
    const check = vi
      .fn()
      .mockResolvedValueOnce([finding])
      .mockImplementation(
        () =>
          new Promise<Diagnostic[]>((resolve) => {
            finish = resolve;
          })
      );
    view = new EditorView({
      doc: 'bad',
      extensions: [
        sourceDiagnostics({
          check,
          enabled: () => enabled,
          syntax: { id: 'plain', ignoreRanges, segment: splitParagraphs },
          subscribeInvalidate: (listener) => {
            invalidate = listener;
            return vi.fn();
          }
        })
      ]
    });
    await vi.advanceTimersByTimeAsync(0);
    invalidate();
    await vi.advanceTimersByTimeAsync(0);
    expect(marks()).toEqual(['bad']);
    invalidate();
    await vi.advanceTimersByTimeAsync(0);
    enabled = false;
    invalidate();
    expect(marks()).toEqual([]);
    expect(check.mock.calls[1][1].aborted).toBe(true);
    finish([finding]);
    await vi.advanceTimersByTimeAsync(0);
    expect(marks()).toEqual([]);
  });

  it('never invokes a provider after destruction during syntax preparation', async () => {
    let prepare!: (ranges: []) => void;
    const check = vi.fn().mockResolvedValue([]);
    view = new EditorView({
      doc: 'bad',
      extensions: [
        sourceDiagnostics({
          check,
          syntax: {
            id: 'plain',
            ignoreRanges: () =>
              new Promise((resolve) => {
                prepare = resolve;
              }),
            segment: splitParagraphs
          }
        })
      ]
    });
    await vi.advanceTimersByTimeAsync(0);
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    view.destroy();
    prepare([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(check).not.toHaveBeenCalled();
  });
});
