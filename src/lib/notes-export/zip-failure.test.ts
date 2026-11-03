import { describe, expect, it, vi } from 'vitest';

const zip = vi.hoisted(() => ({
  report: (_error: Error | null, _chunk: Uint8Array, _final: boolean) => {}
}));
vi.mock('fflate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fflate')>()),
  Zip: class {
    constructor(report: typeof zip.report) {
      zip.report = report;
    }
    add(entry: { ondata: () => void }) {
      entry.ondata = () => {};
    }
    end() {}
  }
}));
import { createExportZip } from './zip';

// A broken archive would only show when someone tries to restore from it.
describe('export zip compression failures', () => {
  const failure = new Error('deflate failed');

  it('fails the write that hit them', async () => {
    const archive = createExportZip();
    zip.report(failure, new Uint8Array(), false);
    await expect(archive.write('note.md', new Uint8Array(1))).rejects.toBe(
      failure
    );
  });

  it('refuses to hand over an archive they left broken', () => {
    const archive = createExportZip();
    zip.report(failure, new Uint8Array(), true);
    expect(() => archive.finish()).toThrow(failure);
  });
});
