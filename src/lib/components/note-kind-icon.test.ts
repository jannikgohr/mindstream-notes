import { describe, expect, it } from 'vitest';
import {
  Feather,
  FileQuestion,
  FileText,
  FileType2,
  PencilRuler,
  SquareKanban
} from '@lucide/svelte';
import { noteKindIcon } from './note-kind-icon';

describe('noteKindIcon', () => {
  it('falls back to FileText for null/undefined (legacy rows)', () => {
    expect(noteKindIcon(null)).toBe(FileText);
    expect(noteKindIcon(undefined)).toBe(FileText);
  });

  it('maps each known kind to its glyph', () => {
    expect(noteKindIcon('markdown')).toBe(FileText);
    expect(noteKindIcon('freeform')).toBe(PencilRuler);
    expect(noteKindIcon('ink')).toBe(Feather);
    expect(noteKindIcon('pdf')).toBe(FileType2);
    expect(noteKindIcon('kanban')).toBe(SquareKanban);
  });

  it('uses FileQuestion for an unknown future kind', () => {
    expect(noteKindIcon('hologram')).toBe(FileQuestion);
    expect(noteKindIcon('')).toBe(FileQuestion);
  });
});
