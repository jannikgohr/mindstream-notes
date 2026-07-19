import type { CollabCredentialsChangedPayload } from '$lib/api/events';

export function collabCredentialsChangedForNote(
  payload: CollabCredentialsChangedPayload,
  noteId: string
): boolean {
  return payload.note_ids.includes(noteId);
}
