import { expect, it } from 'vitest';
import { demoNoteId } from './demo-note-id';

it('hashes the UTF-8 title length, title, and document bytes using the native ID format', async () => {
  // SHA-256 of a u64 little-endian byte length, UTF-8 title, and raw Yjs bytes.
  expect(
    await demoNoteId({
      slug: 'sync',
      lang: 'de',
      title: 'Grüße 🌱',
      body: '',
      yrsState: [0, 127, 128, 255]
    })
  ).toBe('demo_sync_de_84dbad7d128e7f19');
});
