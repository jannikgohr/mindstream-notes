import { describe, expect, it } from 'vitest';
import {
  applyDateOffset,
  applyFilter,
  defaultDateFormat,
  formatDate,
  isDateBase,
  parseExpr
} from './template-format';

// Local-time construction keeps the numeric assertions timezone-independent.
const D = new Date(2026, 6, 25, 14, 5, 9); // Sat 25 Jul 2026 14:05:09 local

describe('parseExpr', () => {
  it('parses a bare base', () => {
    expect(parseExpr('owner')).toEqual({
      base: 'owner',
      offset: '',
      format: undefined,
      filters: []
    });
  });

  it('splits base, offset, format and filters', () => {
    expect(parseExpr('date+7d:YYYY-MM-DD|upper|trim')).toEqual({
      base: 'date',
      offset: '+7d',
      format: 'YYYY-MM-DD',
      filters: ['upper', 'trim']
    });
  });

  it('keeps a colon-bearing format intact (only the first colon splits)', () => {
    const p = parseExpr('datetime:YYYY-MM-DD HH:mm');
    expect(p.base).toBe('datetime');
    expect(p.format).toBe('YYYY-MM-DD HH:mm');
  });

  it('does not mistake a hyphenated variable name for an offset', () => {
    expect(parseExpr('my-var')).toMatchObject({ base: 'my-var', offset: '' });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseExpr(' date : YYYY | upper ')).toMatchObject({
      base: 'date',
      format: 'YYYY',
      filters: ['upper']
    });
  });
});

describe('applyDateOffset', () => {
  it('does not mutate the input date', () => {
    const before = D.getTime();
    applyDateOffset(D, '+1d');
    expect(D.getTime()).toBe(before);
  });

  it('applies chained terms with moment unit casing (M month, m minute)', () => {
    expect(formatDate(applyDateOffset(D, '+1M'), 'YYYY-MM-DD')).toBe(
      '2026-08-25'
    );
    expect(formatDate(applyDateOffset(D, '+30m'), 'HH:mm')).toBe('14:35');
    expect(formatDate(applyDateOffset(D, '+1w'), 'YYYY-MM-DD')).toBe(
      '2026-08-01'
    );
    expect(formatDate(applyDateOffset(D, '-1y+2d'), 'YYYY-MM-DD')).toBe(
      '2025-07-27'
    );
  });

  it('applies nothing for an empty or unparseable offset', () => {
    expect(applyDateOffset(D, '').getTime()).toBe(D.getTime());
    expect(applyDateOffset(D, 'garbage').getTime()).toBe(D.getTime());
  });
});

describe('formatDate', () => {
  it('renders numeric tokens locale-independently', () => {
    expect(formatDate(D, 'YYYY-MM-DD HH:mm:ss')).toBe('2026-07-25 14:05:09');
    expect(formatDate(D, 'YY M D H m s')).toBe('26 7 25 14 5 9');
    expect(formatDate(D, 'hh:mm A')).toBe('02:05 PM');
  });

  it('renders named tokens via the given locale', () => {
    expect(formatDate(D, 'MMMM', 'en')).toBe('July');
    expect(formatDate(D, 'MMMM', 'de')).toBe('Juli');
    expect(formatDate(D, 'dddd', 'de')).toBe('Samstag');
  });

  it('passes through literals and [escaped] text', () => {
    expect(formatDate(D, '[Year] YYYY')).toBe('Year 2026');
    expect(formatDate(D, 'YYYY.')).toBe('2026.');
  });
});

describe('applyFilter', () => {
  it('transforms known filters and no-ops unknown ones', () => {
    expect(applyFilter('aBc', 'upper')).toBe('ABC');
    expect(applyFilter('aBc', 'lower')).toBe('abc');
    expect(applyFilter('  x  ', 'trim')).toBe('x');
    expect(applyFilter('hello there', 'capitalize')).toBe('Hello there');
    expect(applyFilter('Héllo, World!', 'slug')).toBe('h-llo-world');
    expect(applyFilter('x', 'nope')).toBe('x');
  });
});

describe('base helpers', () => {
  it('recognises the built-in date bases', () => {
    for (const b of ['date', 'time', 'datetime', 'now']) {
      expect(isDateBase(b)).toBe(true);
    }
    expect(isDateBase('owner')).toBe(false);
    expect(isDateBase('uuid')).toBe(false);
  });

  it('exposes a default format per date base', () => {
    expect(defaultDateFormat('date')).toBe('YYYY-MM-DD');
    expect(defaultDateFormat('time')).toBe('HH:mm');
  });
});
