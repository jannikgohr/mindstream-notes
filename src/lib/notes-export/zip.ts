/**
 * Zip target for the vault export. A browser has no folder to write into on
 * every engine, so its export becomes one download.
 *
 * Note titles become archive paths, and some of those notes can come from
 * other people through a shared folder, so a path that could leave the
 * extraction folder is refused here, as the native writer does on disk.
 */

import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

/**
 * fflate writes no ZIP64 records, so sizes and offsets have to fit in 32 bits.
 * This stops short of 4 GiB to leave room for the headers.
 */
const MAX_ZIP_BYTES = 4_000_000_000;
/** The entry count is a 16-bit field for the same reason. */
const MAX_ZIP_ENTRIES = 0xffff;
/** Text and databases are worth compressing. Images and PDFs are already. */
const COMPRESSIBLE = /\.(md|json|excalidraw|typ|db)$/i;

export function createExportZip() {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let failure: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) failure = error;
    else parts.push(chunk as Uint8Array<ArrayBuffer>);
  });
  let entries = 0;
  let total = 0;

  return {
    async write(relativePath: string, bytes: Uint8Array): Promise<void> {
      const segments = relativePath.split('/');
      if (
        relativePath.includes('\\') ||
        segments.some((segment) => segment === '' || segment === '..')
      ) {
        throw new Error(`Export path escapes the archive: ${relativePath}`);
      }
      if (
        entries + 1 > MAX_ZIP_ENTRIES ||
        total + bytes.length > MAX_ZIP_BYTES
      ) {
        throw new Error('The export is too large for a zip file');
      }
      entries += 1;
      total += bytes.length;
      const entry = COMPRESSIBLE.test(relativePath)
        ? new ZipDeflate(relativePath)
        : new ZipPassThrough(relativePath);
      zip.add(entry);
      entry.push(bytes as Uint8Array<ArrayBuffer>, true);
      if (failure) throw failure;
    },

    finish(): Blob {
      zip.end();
      if (failure) throw failure;
      return new Blob(parts, { type: 'application/zip' });
    }
  };
}
