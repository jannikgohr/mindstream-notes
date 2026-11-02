import { createExportZip } from '../notes-export/zip';
import type { BrowserBackup } from './protocol';

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
  await zip.write('manifest.json', new TextEncoder().encode(manifest));
  await zip.write('data.db', database);
  return { ...report, archive: zip.finish() };
}
