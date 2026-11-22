import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteSummary } from '$lib/api';
import {
  clearNoteRelationsCache,
  loadNoteLinks,
  loadNoteRelations,
  noteLinkIds
} from './note-relations';

function summary(id: string): NoteSummary {
  return {
    id,
    parent_collection_id: null,
    title: id,
    position: 0,
    created: '2026-01-01T00:00:00Z',
    modified: '2026-01-01T00:00:00Z',
    tags: [],
    trashed: false,
    favourite: false,
    pushed: true,
    note_kind: 'markdown'
  };
}

beforeEach(() => clearNoteRelationsCache());

describe('noteLinkIds', () => {
  it('extracts and deduplicates encoded note links', () => {
    expect(
      noteLinkIds(
        '[One](mindstream://note/note-1) and [Two](mindstream://note/a%20b) and [One](mindstream://note/note-1)'
      )
    ).toEqual(['note-1', 'a b']);
  });

  it('ignores ordinary and user links', () => {
    expect(
      noteLinkIds('[Web](https://example.com) [User](mindstream://user/alice)')
    ).toEqual([]);
  });
});

describe('loadNoteRelations', () => {
  it('returns outgoing links and backlinks among live notes', async () => {
    const bodies: Record<string, string> = {
      a: '[B](mindstream://note/b)',
      b: '',
      c: '[A](mindstream://note/a)'
    };
    const loader = vi.fn(async (id: string) => ({ body: bodies[id] ?? '' }));

    const pdfTarget = summary('b');
    pdfTarget.note_kind = 'pdf';

    await expect(
      loadNoteRelations('a', [summary('a'), pdfTarget, summary('c')], loader)
    ).resolves.toEqual({ outgoing: ['b'], backlinks: ['c'] });
  });

  it('shares body loads between concurrent sidebar sections', async () => {
    const loader = vi.fn(async () => ({ body: '' }));
    const notes = [summary('a'), summary('b')];

    await Promise.all([
      loadNoteRelations('a', notes, loader),
      loadNoteRelations('a', notes, loader)
    ]);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('does not index links from non-Markdown notes', async () => {
    const kanban = summary('board');
    kanban.note_kind = 'kanban';
    const loader = vi.fn(async () => ({
      body: '[A](mindstream://note/a)'
    }));

    await expect(
      loadNoteRelations('board', [kanban, summary('a')], loader)
    ).resolves.toEqual({ outgoing: [], backlinks: [] });
    expect(loader).toHaveBeenCalledOnce();
    expect(loader).toHaveBeenCalledWith('a');
  });
});

describe('loadNoteLinks', () => {
  it('reads a large vault’s links at once and reloads only notes changed since', async () => {
    const notes = Array.from({ length: 30 }, (_, i) => summary(`n${i}`));
    const lister = vi.fn(async () =>
      notes.map((note, i) => ({
        id: note.id,
        modified: note.modified,
        targets: [`n${(i + 1) % 30}`, 'gone']
      }))
    );
    const loader = vi.fn(async () => ({ body: '[n5](mindstream://note/n5)' }));

    const links = await loadNoteLinks(notes, loader, lister);
    expect(links.get('n0')).toEqual(['n1']);
    expect(lister).toHaveBeenCalledOnce();
    expect(loader).not.toHaveBeenCalled();

    notes[0] = { ...notes[0], modified: '2026-02-01T00:00:00Z' };
    expect((await loadNoteLinks(notes, loader, lister)).get('n0')).toEqual([
      'n5'
    ]);
    expect(lister).toHaveBeenCalledOnce();
    expect(loader).toHaveBeenCalledOnce();
    expect(loader).toHaveBeenCalledWith('n0');
  });
});
