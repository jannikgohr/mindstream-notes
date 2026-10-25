import type { DemoNote } from '$lib/api/onboarding';

/** Matches DemoNote::id in src-tauri/src/demo_notes.rs, including UTF-8 length. */
export async function demoNoteId(note: DemoNote): Promise<string> {
  const title = new TextEncoder().encode(note.title);
  const bytes = new Uint8Array(8 + title.length + note.yrsState.length);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(title.length), true);
  bytes.set(title, 8);
  bytes.set(note.yrsState, 8 + title.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = Array.from(digest.slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return `demo_${note.slug}_${note.lang}_${hash}`;
}
