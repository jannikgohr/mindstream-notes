import type { NoteKind, NoteSummary } from '$lib/api';
import { inkExporters } from './ink';
import { pdfExporters } from './pdf';
import type { NoteExporter } from './types';

const EXPORTERS_BY_KIND: Partial<Record<NoteKind, NoteExporter[]>> = {
  ink: inkExporters,
  pdf: pdfExporters
};

export function exportersForNote(
  note: Pick<NoteSummary, 'note_kind'> | null | undefined
): NoteExporter[] {
  if (!note) return [];
  return EXPORTERS_BY_KIND[note.note_kind] ?? [];
}

export type { NoteExporter };
