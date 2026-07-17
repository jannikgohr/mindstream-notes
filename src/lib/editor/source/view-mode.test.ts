/**
 * View-mode availability rules. All three surfaces are offered on every
 * platform; the only constraint is that Split needs the viewport width for two
 * side-by-side panes, so it drops out below `SPLIT_MIN_WIDTH`.
 */

import { describe, expect, it } from 'vitest';
import {
  SPLIT_MIN_WIDTH,
  coerceViewMode,
  nextViewMode,
  splitFitsWidth,
  viewModesFor
} from './view-mode';

describe('splitFitsWidth', () => {
  it('offers split at or above the threshold', () => {
    expect(splitFitsWidth(SPLIT_MIN_WIDTH)).toBe(true);
    expect(splitFitsWidth(1280)).toBe(true);
  });

  it('withholds split below the threshold', () => {
    expect(splitFitsWidth(SPLIT_MIN_WIDTH - 1)).toBe(false);
    expect(splitFitsWidth(390)).toBe(false); // phone portrait
  });

  it('treats an unknown width (SSR) as available', () => {
    // Hiding the option in server-rendered HTML would make it flicker in on
    // hydration; the client re-evaluates on mount.
    expect(splitFitsWidth(undefined)).toBe(true);
  });
});

describe('viewModesFor', () => {
  it('offers all three when split fits', () => {
    expect(viewModesFor(true)).toEqual(['wysiwyg', 'source', 'split']);
  });

  it('drops split when it does not fit, keeping the others in order', () => {
    expect(viewModesFor(false)).toEqual(['wysiwyg', 'source']);
  });
});

describe('coerceViewMode', () => {
  it('passes through valid modes', () => {
    expect(coerceViewMode('wysiwyg')).toBe('wysiwyg');
    expect(coerceViewMode('source')).toBe('source');
    expect(coerceViewMode('split')).toBe('split');
  });

  it('falls back to wysiwyg for junk', () => {
    expect(coerceViewMode('nonsense')).toBe('wysiwyg');
    expect(coerceViewMode(undefined)).toBe('wysiwyg');
    expect(coerceViewMode(null)).toBe('wysiwyg');
    expect(coerceViewMode(3)).toBe('wysiwyg');
  });

  it('coerces split to wysiwyg when split is unavailable', () => {
    // editor.defaultMode is vault-scoped, so a Split chosen on a desktop
    // arrives on the phone. Coercing at the point of use is what lets the
    // phone open in WYSIWYG without writing the value back.
    expect(coerceViewMode('split', false)).toBe('wysiwyg');
  });

  it('leaves the non-split modes alone when split is unavailable', () => {
    expect(coerceViewMode('source', false)).toBe('source');
    expect(coerceViewMode('wysiwyg', false)).toBe('wysiwyg');
  });
});

describe('nextViewMode', () => {
  it('cycles through all three when split fits', () => {
    expect(nextViewMode('wysiwyg', true)).toBe('source');
    expect(nextViewMode('source', true)).toBe('split');
    expect(nextViewMode('split', true)).toBe('wysiwyg');
  });

  it('cycles wysiwyg <-> source when split does not fit', () => {
    expect(nextViewMode('wysiwyg', false)).toBe('source');
    expect(nextViewMode('source', false)).toBe('wysiwyg');
  });

  it('resumes the cycle when the current mode is no longer on offer', () => {
    // The viewport shrank under an open Split pane; the toggle must still go
    // somewhere valid rather than getting stuck.
    expect(nextViewMode('split', false)).toBe('wysiwyg');
  });
});
