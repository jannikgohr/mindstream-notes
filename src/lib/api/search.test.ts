import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args)
}));

import { searchNotes } from './search';

const NOTE = {
  id: 'n1',
  parent_collection_id: null,
  title: 'Groceries',
  position: 0,
  created: '2026-01-01T00:00:00Z',
  modified: '2026-01-01T00:00:00Z',
  tags: [],
  trashed: false,
  favourite: false,
  pushed: true,
  note_kind: 'markdown'
};

const HIT = {
  note: NOTE,
  snippet: 'buy milk',
  title_matches: [{ start: 0, end: 3 }],
  snippet_matches: [{ start: 4, end: 8 }]
};

function setTauri(on: boolean): void {
  if (on)
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  else
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

describe('searchNotes — browser fallback', () => {
  it('resolves to an array via the mock store', async () => {
    await expect(searchNotes('anything')).resolves.toBeInstanceOf(Array);
  });
});

describe('searchNotes — Tauri (parse path)', () => {
  beforeEach(() => {
    setTauri(true);
    invoke.mockReset();
  });
  afterEach(() => setTauri(false));

  it('parses a well-formed hit with match ranges', async () => {
    invoke.mockResolvedValue([HIT]);
    const hits = await searchNotes('milk');
    expect(hits).toHaveLength(1);
    expect(hits[0].note.id).toBe('n1');
    expect(hits[0].snippet).toBe('buy milk');
    expect(hits[0].title_matches).toEqual([{ start: 0, end: 3 }]);
    expect(invoke).toHaveBeenCalledWith('search_notes', { query: 'milk' });
  });

  it('throws when the response is not an array', async () => {
    invoke.mockResolvedValue({});
    await expect(searchNotes('x')).rejects.toThrow(
      /search response must be an array/
    );
  });

  it('throws when a match-range list is not an array', async () => {
    invoke.mockResolvedValue([{ ...HIT, title_matches: 'nope' }]);
    await expect(searchNotes('x')).rejects.toThrow(
      /title_matches must be an array/
    );
  });

  it('throws when a match range is missing an endpoint', async () => {
    invoke.mockResolvedValue([{ ...HIT, snippet_matches: [{ start: 1 }] }]);
    await expect(searchNotes('x')).rejects.toThrow(/match range.end/);
  });
});
