import { describe, expect, it } from 'vitest';
import { createNote } from './notes';
import { noteWordCount } from './content-stats';

describe('content stats API (browser fallback)', () => {
  it('counts words for a saved markdown note', async () => {
    const note = await createNote({
      title: 'Stats wrapper',
      body: '# Heading\n\nHello **wide** world'
    });

    expect(await noteWordCount(note.id)).toBe(4);
  });

  it('returns zero for a missing note', async () => {
    expect(await noteWordCount('missing-note')).toBe(0);
  });
});
