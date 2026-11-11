import { describe, expect, it } from 'vitest';
import { rankSubstringMatches } from './substring-rank';

const identity = (text: string) => text;

describe('rankSubstringMatches', () => {
  it('puts prefix matches first, then earlier interior matches', () => {
    expect(
      rankSubstringMatches(
        ['Meeting Notes', 'Notes plan', 'Ideas'],
        'note',
        identity,
        8
      )
    ).toEqual(['Notes plan', 'Meeting Notes']);
    expect(
      rankSubstringMatches(['big note', 'a note'], 'note', identity, 8)
    ).toEqual(['a note', 'big note']);
  });

  it('breaks interior ties on shorter text and keeps input order otherwise', () => {
    expect(
      rankSubstringMatches(['ab note extra', 'ab note'], 'note', identity, 8)
    ).toEqual(['ab note', 'ab note extra']);
    expect(
      rankSubstringMatches(['Note B', 'Note A'], 'note', identity, 8)
    ).toEqual(['Note B', 'Note A']);
  });

  it('returns the first matches in input order for an empty query', () => {
    expect(rankSubstringMatches(['b', 'a', 'c'], '', identity, 2)).toEqual([
      'b',
      'a'
    ]);
  });

  it('caps results at the limit and reads text through textOf', () => {
    const users = [{ name: 'ada1' }, { name: 'ada2' }, { name: 'ada3' }];
    expect(rankSubstringMatches(users, 'ada', (user) => user.name, 2)).toEqual([
      { name: 'ada1' },
      { name: 'ada2' }
    ]);
  });
});
