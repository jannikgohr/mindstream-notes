import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { packBackup } from './backup-archive';

async function unpack(blob: Blob) {
  // jsdom's Blob has no arrayBuffer().
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
  return unzipSync(new Uint8Array(bytes));
}

describe('backup archive', () => {
  it('holds the manifest first, then the exact snapshot, and nothing else', async () => {
    const database = new Uint8Array([83, 81, 76, 0, 255]);
    const counts = { notes: 1, folders: 0, assets_bytes: 0 };
    const backup = await packBackup({
      manifest: '{"format_version":1}',
      database,
      filename: 'mindstream-backup.zip',
      counts,
      accountPresent: false
    });

    expect(backup).toMatchObject({
      filename: 'mindstream-backup.zip',
      counts,
      accountPresent: false
    });
    expect(backup.archive.type).toBe('application/zip');
    const files = await unpack(backup.archive);
    expect(Object.keys(files)).toEqual(['manifest.json', 'data.db']);
    expect(strFromU8(files['manifest.json'])).toBe('{"format_version":1}');
    expect(files['data.db']).toEqual(database);
  });
});
