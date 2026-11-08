/**
 * Zip target for the vault export. A browser has no folder to write into on
 * every engine, so its export becomes one archive: streamed to a file the
 * user picked where the browser allows it, or held in memory and downloaded.
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

/** Where a streamed archive goes, such as a picked file's writable stream. */
export interface ZipSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** Feeds entries into an fflate archive with the export's path and size rules. */
function createZipWriter(onChunk: (chunk: Uint8Array) => void) {
  let failure: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) failure = error;
    else onChunk(chunk);
  });
  let entries = 0;
  let total = 0;

  return {
    add(relativePath: string, bytes: Uint8Array): void {
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

    end(): void {
      zip.end();
      if (failure) throw failure;
    }
  };
}

/** An archive built in memory, returned as one Blob. */
export function createExportZip() {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const zip = createZipWriter((chunk) =>
    parts.push(chunk as Uint8Array<ArrayBuffer>)
  );

  return {
    async write(relativePath: string, bytes: Uint8Array): Promise<void> {
      zip.add(relativePath, bytes);
    },

    finish(): Blob {
      zip.end();
      return new Blob(parts, { type: 'application/zip' });
    }
  };
}

/**
 * An archive streamed to `sink`. Each `write` resolves once its bytes reached
 * the sink, so memory holds one file at a time rather than the whole vault.
 */
export function createStreamingExportZip(sink: ZipSink) {
  let pending: Promise<void> = Promise.resolve();
  const zip = createZipWriter((chunk) => {
    pending = pending.then(() => sink.write(chunk));
  });

  return {
    async write(relativePath: string, bytes: Uint8Array): Promise<void> {
      zip.add(relativePath, bytes);
      await pending;
    },

    async finish(): Promise<void> {
      zip.end();
      await pending;
      await sink.close();
    }
  };
}
