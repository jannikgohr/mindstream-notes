import { describe, expect, it } from 'vitest';

import { collabCredentialsChangedForNote } from './collab-credentials';

describe('collabCredentialsChangedForNote', () => {
  it('matches only notes listed in the rotation event', () => {
    const payload = { note_ids: ['note_a', 'note_b'] };

    expect(collabCredentialsChangedForNote(payload, 'note_a')).toBe(true);
    expect(collabCredentialsChangedForNote(payload, 'note_c')).toBe(false);
  });
});
