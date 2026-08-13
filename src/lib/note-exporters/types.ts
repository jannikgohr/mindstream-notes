export interface NoteExporter {
  id: string;
  noteKind: string;
  label: string;
  run: (noteId: string) => Promise<void>;
}
