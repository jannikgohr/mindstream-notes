import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { createExportZip } from './zip';

async function entries(blob: Blob) {
  // jsdom's Blob has no arrayBuffer().
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
  return unzipSync(new Uint8Array(bytes));
}

describe('export zip', () => {
  it('keeps folders, unicode names and exact bytes', async () => {
    const zip = createExportZip();
    const image = new Uint8Array([137, 80, 78, 71, 0, 255]);
    await zip.write('Grüße/Köln.md', strToU8('# Dom\n'));
    await zip.write('Grüße/_assets/photo.png', image);

    const files = await entries(zip.finish());
    expect(Object.keys(files).sort()).toEqual([
      'Grüße/Köln.md',
      'Grüße/_assets/photo.png'
    ]);
    expect(strFromU8(files['Grüße/Köln.md'])).toBe('# Dom\n');
    expect(files['Grüße/_assets/photo.png']).toEqual(image);
  });

  it('compresses text and stores what is compressed already', async () => {
    const repeated = new Uint8Array(100_000);
    const text = createExportZip();
    await text.write('note.md', repeated);
    const stored = createExportZip();
    await stored.write('scan.pdf', repeated);

    expect(text.finish().size).toBeLessThan(1_000);
    expect(stored.finish().size).toBeGreaterThan(100_000);
  });

  it('refuses a path that could leave the extraction folder', async () => {
    const zip = createExportZip();
    for (const path of [
      '../evil.md',
      'notes/../../evil.md',
      '/etc/evil.md',
      'notes\\evil.md',
      'notes//evil.md'
    ]) {
      await expect(zip.write(path, new Uint8Array(1))).rejects.toThrow(
        'escapes the archive'
      );
    }
  });

  it('refuses to outgrow the zip format and keeps what it has', async () => {
    const zip = createExportZip();
    await zip.write('kept.md', strToU8('kept'));
    const oversized = { length: 4_000_000_001 } as Uint8Array;
    await expect(zip.write('huge.pdf', oversized)).rejects.toThrow('too large');

    const files = await entries(zip.finish());
    expect(Object.keys(files)).toEqual(['kept.md']);
  });
});
