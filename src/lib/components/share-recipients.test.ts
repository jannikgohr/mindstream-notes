import { describe, expect, it } from 'vitest';
import { parseRecipients } from './share-recipients';

describe('parseRecipients', () => {
  it('parses a single username', () => {
    expect(parseRecipients('alice')).toEqual(['alice']);
  });

  it('splits on commas and trims each name', () => {
    expect(parseRecipients('alice, bob ,  carol')).toEqual([
      'alice',
      'bob',
      'carol'
    ]);
  });

  it('drops empty entries from stray or trailing commas', () => {
    expect(parseRecipients('alice,,bob,')).toEqual(['alice', 'bob']);
    expect(parseRecipients('  ,  ')).toEqual([]);
  });

  it('de-duplicates case-insensitively, keeping the first spelling', () => {
    expect(parseRecipients('Alice, alice, ALICE')).toEqual(['Alice']);
    expect(parseRecipients('bob, Bob, carol')).toEqual(['bob', 'carol']);
  });

  it('does NOT split on spaces — a username is one token', () => {
    // A fat-fingered "alice bob" is one (invalid) name, not two invites.
    expect(parseRecipients('alice bob')).toEqual(['alice bob']);
  });

  it('also splits on newlines (future-proofing a multi-line field)', () => {
    expect(parseRecipients('alice\nbob')).toEqual(['alice', 'bob']);
  });

  it('returns an empty list for blank input', () => {
    expect(parseRecipients('')).toEqual([]);
    expect(parseRecipients('   ')).toEqual([]);
  });
});
