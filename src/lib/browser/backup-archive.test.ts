import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { packBackup, unpackBackup } from './backup-archive';

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

  it('reads the manifest and snapshot and lists what else is there', () => {
    const database = new Uint8Array([83, 81, 76]);
    const unpacked = unpackBackup(
      zipSync({
        'manifest.json': strToU8('{"format_version":2}'),
        'data.db': database,
        'portable.json': strToU8('{}')
      })
    );
    expect(unpacked.manifest).toBe('{"format_version":2}');
    expect(unpacked.database).toEqual(database);
    expect(unpacked.entries).toEqual([
      'manifest.json',
      'data.db',
      'portable.json'
    ]);
  });

  it('refuses what is not a backup', () => {
    const refused = expect.objectContaining({
      code: 'invalidArgument',
      message: 'This file is not a Mindstream backup.'
    });
    expect(() => unpackBackup(strToU8('not a zip'))).toThrow();
    for (const bytes of [
      strToU8('not a zip'),
      zipSync({ 'notes.md': strToU8('text') }),
      zipSync({ 'manifest.json': strToU8('{}') })
    ]) {
      try {
        unpackBackup(bytes);
        expect.unreachable();
      } catch (error) {
        expect(error).toEqual(refused);
      }
    }
  });

  it('checks the size before inflating anything', () => {
    const zip = zipSync({
      'manifest.json': strToU8('{}'),
      'data.db': new Uint8Array(4)
    });
    // Claim a huge snapshot in the central directory record for data.db.
    const view = new DataView(zip.buffer);
    let offset = zip.length - 22;
    offset = view.getUint32(offset + 16, true);
    offset += 46 + view.getUint16(offset + 28, true);
    view.setUint32(offset + 24, 2 ** 31, true);

    try {
      unpackBackup(zip);
      expect.unreachable();
    } catch (error) {
      expect(error).toEqual(
        expect.objectContaining({
          message: 'This backup is too large to restore in a browser.'
        })
      );
    }
  });
});
