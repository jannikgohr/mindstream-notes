import { describe, expect, it } from 'vitest';
import { exportersForNote } from './index';
import type { NoteKind } from '$lib/api';

function note(kind: NoteKind) {
  return { note_kind: kind };
}

describe('note exporters', () => {
  it('offers PDF export for handwritten notes', () => {
    expect(
      exportersForNote(note('ink')).map((exporter) => exporter.id)
    ).toEqual(['ink.pdf']);
  });

  it('keeps annotated PDF export for PDF notes', () => {
    expect(
      exportersForNote(note('pdf')).map((exporter) => exporter.id)
    ).toEqual(['pdf.annotated']);
  });

  it('does not offer exporters for note kinds without direct exports', () => {
    expect(exportersForNote(note('markdown'))).toEqual([]);
    expect(exportersForNote(note('freeform'))).toEqual([]);
  });
});
