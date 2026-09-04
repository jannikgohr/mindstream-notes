import { describe, expect, it } from 'vitest';
import { droppedPdfFiles, isFileDrag } from './file-drop';

function dragEvent(files: File[], types: string[] = ['Files']): DragEvent {
  return {
    dataTransfer: { files, types }
  } as unknown as DragEvent;
}

describe('file drop helpers', () => {
  it('recognises external file drags before the files are readable', () => {
    expect(isFileDrag(dragEvent([], ['Files']))).toBe(true);
    expect(isFileDrag(dragEvent([], ['text/plain']))).toBe(false);
  });

  it('accepts PDFs by MIME type or extension', () => {
    const typed = new File(['pdf'], 'document.bin', {
      type: 'application/pdf'
    });
    const named = new File(['pdf'], 'scan.PDF');
    const text = new File(['text'], 'notes.txt', { type: 'text/plain' });
    expect(droppedPdfFiles(dragEvent([typed, named, text]))).toEqual([
      typed,
      named
    ]);
  });
});
