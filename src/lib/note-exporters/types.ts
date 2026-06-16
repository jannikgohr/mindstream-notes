import type { NoteKind } from '$lib/api';

export interface NoteExporter {
  id: string;
  noteKind: NoteKind;
  label: string;
  run: (noteId: string) => Promise<void>;
}
