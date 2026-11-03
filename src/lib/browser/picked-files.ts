import type { PickedSource } from './protocol';

interface RangeReader {
  readAsArrayBuffer(blob: Blob): ArrayBuffer;
}

/** It exists in workers only, so the DOM types leave it out. */
declare const FileReaderSync: new () => RangeReader;

/**
 * The files the user picked, as the importer reads them from the worker. The
 * importer asks for one range at a time, so a large export is never held in
 * memory whole.
 */
export class PickedFiles {
  private files: Map<string, File>;

  constructor(
    files: PickedSource['files'],
    private reader: RangeReader = new FileReaderSync()
  ) {
    this.files = new Map(files.map(({ path, file }) => [path, file]));
  }

  paths(): string[] {
    return [...this.files.keys()];
  }

  size(path: string): number | undefined {
    return this.files.get(path)?.size;
  }

  modified(path: string): number | undefined {
    return this.files.get(path)?.lastModified;
  }

  readRange(path: string, start: number, length: number): Uint8Array {
    const file = this.files.get(path);
    if (!file) throw `${path} is not in the picked files`;
    return new Uint8Array(
      this.reader.readAsArrayBuffer(file.slice(start, start + length))
    );
  }
}
