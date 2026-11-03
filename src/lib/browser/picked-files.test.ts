import { describe, expect, it, vi } from 'vitest';
import { PickedFiles } from './picked-files';

function picked(files: Record<string, string>) {
  const entries = Object.entries(files).map(([path, text]) => ({
    path,
    file: new File([text], path, { lastModified: 1_700_000_000_000 })
  }));
  // jsdom has neither FileReaderSync nor Blob.arrayBuffer().
  const chunks: Blob[] = [];
  const reader = {
    readAsArrayBuffer: vi.fn((blob: Blob) => {
      chunks.push(blob);
      return new TextEncoder().encode('range').buffer;
    })
  };
  return { files: new PickedFiles(entries, reader), reader, chunks };
}

describe('picked files', () => {
  it('lists what was picked and describes each file', () => {
    const { files } = picked({ 'a.md': 'one', 'sub/b.md': 'three' });
    expect(files.paths()).toEqual(['a.md', 'sub/b.md']);
    expect(files.size('sub/b.md')).toBe(5);
    expect(files.modified('a.md')).toBe(1_700_000_000_000);
    expect(files.size('missing')).toBeUndefined();
    expect(files.modified('missing')).toBeUndefined();
  });

  it('reads only the range asked for', () => {
    const { files, reader, chunks } = picked({ 'a.md': 'abcdefgh' });
    const bytes = files.readRange('a.md', 2, 3);
    expect(new TextDecoder().decode(bytes)).toBe('range');
    expect(reader.readAsArrayBuffer).toHaveBeenCalledOnce();
    expect(chunks[0].size).toBe(3);
  });

  it('names a file that was not picked', () => {
    const { files } = picked({});
    expect(() => files.readRange('gone.md', 0, 1)).toThrow(
      'gone.md is not in the picked files'
    );
  });
});
