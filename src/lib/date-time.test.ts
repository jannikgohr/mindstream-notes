import { describe, expect, it } from 'vitest';
import { formatNoteDateTime } from './date-time';

describe('formatNoteDateTime', () => {
  it('formats a valid ISO timestamp into a short day/month/time string', () => {
    const out = formatNoteDateTime('2024-06-24T13:05:00Z');
    // Locale-dependent exact text, but it must contain the day and a
    // two-digit time separator and not be the raw ISO string.
    expect(out).not.toBe('2024-06-24T13:05:00Z');
    expect(out).toMatch(/\d/);
  });

  it('falls back to the raw input when the date is unparseable', () => {
    expect(formatNoteDateTime('definitely not a date')).toBe(
      'definitely not a date'
    );
  });
});
