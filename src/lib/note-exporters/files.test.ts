import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { bundleExportFiles, exportFilename, textFile } from './files';

describe('export files', () => {
  it('rejects exports with no pages', async () => {
    await expect(bundleExportFiles('Empty', [])).rejects.toThrow(
      'did not produce any files'
    );
  });
  it('sanitizes plugin and note filenames', () => {
    expect(exportFilename('../../CON', 'csv')).not.toContain('/');
    expect(exportFilename('CON', 'csv')).toBe('CON_file.csv');
    expect(exportFilename('Report.CSV', 'csv')).toBe('Report.CSV');
  });
  it('saves one page directly and bundles every page in a real ZIP', async () => {
    const first = textFile('page-001', 'svg', '<svg>one</svg>');
    expect((await bundleExportFiles('Drawing', [first])).name).toBe(
      'Drawing.svg'
    );
    const result = await bundleExportFiles('Drawing', [
      first,
      textFile('page-002', 'svg', '<svg>two</svg>')
    ]);
    expect(result.format).toBe('zip');
    const archive = unzipSync(result.bytes);
    expect(Object.keys(archive)).toEqual(['page-001.svg', 'page-002.svg']);
    expect(strFromU8(archive['page-002.svg'])).toBe('<svg>two</svg>');
  });
});
