import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { createExportZip, createStreamingExportZip } from './zip';

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

describe('streamed export zip', () => {
  function collecting() {
    const chunks: Uint8Array[] = [];
    let closed = false;
    return {
      chunks,
      get closed() {
        return closed;
      },
      sink: {
        write: async (chunk: Uint8Array) => {
          chunks.push(chunk.slice());
        },
        close: async () => {
          closed = true;
        }
      }
    };
  }

  function joined(chunks: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  it('writes the same archive as the in-memory zip, then closes the sink', async () => {
    const target = collecting();
    const zip = createStreamingExportZip(target.sink);
    const image = new Uint8Array([137, 80, 78, 71, 0, 255]);
    await zip.write('Grüße/Köln.md', strToU8('# Dom\n'));
    await zip.write('Grüße/_assets/photo.png', image);
    expect(target.closed).toBe(false);
    await zip.finish();
    expect(target.closed).toBe(true);

    const files = unzipSync(joined(target.chunks));
    expect(strFromU8(files['Grüße/Köln.md'])).toBe('# Dom\n');
    expect(files['Grüße/_assets/photo.png']).toEqual(image);
  });

  it('does not take the next file until the sink has written the last', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const zip = createStreamingExportZip({
      write: () => gate,
      close: async () => {}
    });
    let done = false;
    const writing = zip.write('scan.pdf', new Uint8Array(10)).then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await writing;
    expect(done).toBe(true);
  });

  it('surfaces a failed disk write', async () => {
    const zip = createStreamingExportZip({
      write: async () => {
        throw new Error('disk full');
      },
      close: async () => {}
    });
    await expect(zip.write('a.md', strToU8('x'))).rejects.toThrow('disk full');
  });

  it('keeps the path and size rules', async () => {
    const zip = createStreamingExportZip(collecting().sink);
    await expect(zip.write('../escape.md', strToU8('x'))).rejects.toThrow(
      'escapes'
    );
  });
});
