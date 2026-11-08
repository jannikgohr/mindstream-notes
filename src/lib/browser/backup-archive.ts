import { strFromU8, unzipSync } from 'fflate';
import { createExportZip } from '../notes-export/zip';
import type { BrowserBackup } from './protocol';

/** The snapshot goes through Wasm memory whole, as it does for a backup. */
export const MAX_BACKUP_BYTES = 2 ** 30;
const MANIFEST = 'manifest.json';
const DATABASE = 'data.db';

/** What the Wasm side hands over for a backup, before it is zipped. */
export type BackupParts = Omit<BrowserBackup, 'archive'> & {
  manifest: string;
  database: Uint8Array;
};

/**
 * Zip a backup the way the app does: the manifest comes first, so that a
 * reader can identify the file from its first entry.
 */
export async function packBackup({
  manifest,
  database,
  ...report
}: BackupParts): Promise<BrowserBackup> {
  const zip = createExportZip();
  await zip.write(MANIFEST, new TextEncoder().encode(manifest));
  await zip.write(DATABASE, database);
  return { ...report, archive: zip.finish() };
}

export interface UnpackedBackup {
  manifest: string;
  /** Everything in the zip, so that the manifest can be checked against it. */
  entries: string[];
  database: Uint8Array;
}

function notABackup(message: string) {
  return { code: 'invalidArgument', message };
}

/**
 * Read the manifest and snapshot out of a backup zip. Native backups also
 * carry resources for the app, which stay compressed, because a browser
 * restores the database only. Each size is checked before it is inflated,
 * and again after: the size a zip declares need not match what it holds.
 */
export function unpackBackup(
  bytes: Uint8Array,
  maxBytes = MAX_BACKUP_BYTES
): UnpackedBackup {
  const tooLarge = () =>
    notABackup('This backup is too large to restore in a browser.');
  const entries: string[] = [];
  let files;
  try {
    files = unzipSync(bytes, {
      filter: ({ name, originalSize }) => {
        entries.push(name);
        const wanted = name === MANIFEST || name === DATABASE;
        if (wanted && originalSize > maxBytes) throw new RangeError();
        return wanted;
      }
    });
  } catch (error) {
    throw error instanceof RangeError
      ? tooLarge()
      : notABackup('This file is not a Mindstream backup.');
  }
  if (!files[MANIFEST] || !files[DATABASE])
    throw notABackup('This file is not a Mindstream backup.');
  if (files[MANIFEST].length > maxBytes || files[DATABASE].length > maxBytes)
    throw tooLarge();
  return {
    manifest: strFromU8(files[MANIFEST]),
    entries,
    database: files[DATABASE]
  };
}
