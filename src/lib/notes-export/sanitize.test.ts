import { describe, expect, it } from 'vitest';
import { dedupeAgainst, sanitizeName } from './sanitize';

describe('sanitizeName', () => {
  it('replaces Windows reserved characters with spaces, then collapses', () => {
    // Each unsafe char becomes a space; runs of whitespace collapse to
    // a single space; internal alphanumerics survive.
    expect(sanitizeName('a/b\\c:d?e*f"g<h>i|j')).toBe('a b c d e f g h i j');
  });

  it('collapses whitespace runs introduced by removed delimiters', () => {
    expect(sanitizeName('a / b / c')).toBe('a b c');
  });

  it('preserves internal single spaces (human-readable filenames)', () => {
    expect(sanitizeName('Sprint planning')).toBe('Sprint planning');
  });

  it('trims leading/trailing whitespace and trailing dots', () => {
    expect(sanitizeName('  hello world.  ')).toBe('hello world');
  });

  it('falls back to Untitled for empty input', () => {
    expect(sanitizeName('')).toBe('Untitled');
    expect(sanitizeName('   ')).toBe('Untitled');
  });

  it('disambiguates reserved Windows device names', () => {
    expect(sanitizeName('CON')).toBe('CON_file');
    expect(sanitizeName('com1')).toBe('com1_file');
    expect(sanitizeName('PRN')).toBe('PRN_file');
  });

  it('disambiguates a reserved device name followed by an extension', () => {
    expect(sanitizeName('CON.txt')).toBe('CON_file.txt');
    expect(sanitizeName('nul.tar.gz')).toBe('nul_file.tar.gz');
    expect(sanitizeName('Console.txt')).toBe('Console.txt');
  });

  it('truncates to the given max length', () => {
    const name = 'x'.repeat(500);
    const out = sanitizeName(name, 50);
    expect(out.length).toBe(50);
  });

  it('keeps a name within the byte limit of common file systems', () => {
    const out = sanitizeName('漢'.repeat(120));
    expect(
      new TextEncoder().encode(`${out}_99.excalidraw`).length
    ).toBeLessThan(255);
    expect(out).toBe('漢'.repeat(66));
  });

  it('never cuts a character in half', () => {
    const out = sanitizeName('😀'.repeat(10), 5);
    expect(out).toBe('😀'.repeat(2));
  });
});

describe('dedupeAgainst', () => {
  it('returns the desired name when no collision', () => {
    const taken = new Set<string>();
    expect(dedupeAgainst(taken, 'note.md')).toBe('note.md');
    expect(taken.has('note.md')).toBe(true);
  });

  it('appends _2, _3 on repeated collisions before the extension', () => {
    const taken = new Set<string>();
    expect(dedupeAgainst(taken, 'note.md')).toBe('note.md');
    expect(dedupeAgainst(taken, 'note.md')).toBe('note_2.md');
    expect(dedupeAgainst(taken, 'note.md')).toBe('note_3.md');
  });

  it('handles names without an extension', () => {
    const taken = new Set<string>();
    dedupeAgainst(taken, 'Folder');
    expect(dedupeAgainst(taken, 'Folder')).toBe('Folder_2');
  });

  it('treats names that differ only in case or normalisation as one', () => {
    const taken = new Set<string>();
    expect(dedupeAgainst(taken, 'Plan.md')).toBe('Plan.md');
    expect(dedupeAgainst(taken, 'plan.md')).toBe('plan_2.md');
    expect(dedupeAgainst(taken, 'Café.md')).toBe('Café.md');
    expect(dedupeAgainst(taken, 'Cafe\u0301.md')).toBe('Cafe\u0301_2.md');
  });

  it('mutates the taken set so callers can dedup across a directory', () => {
    const taken = new Set<string>();
    dedupeAgainst(taken, 'a.md');
    dedupeAgainst(taken, 'a.md');
    expect(taken.has('a.md')).toBe(true);
    expect(taken.has('a_2.md')).toBe(true);
  });
});
