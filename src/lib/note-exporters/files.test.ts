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

  it('keeps both pages when title truncation removes their page numbers', async () => {
    const title = 'x'.repeat(115);
    const first = textFile(`${title} - 001`, 'svg', 'first');
    const second = textFile(`${title} - 002`, 'svg', 'second');
    expect(first.name).toBe(second.name);
    const archive = unzipSync(
      (await bundleExportFiles(title, [first, second])).bytes
    );
    const renamed = `${first.name.slice(0, -4)}_2.svg`;
    expect(Object.keys(archive)).toEqual([first.name, renamed]);
    expect(strFromU8(archive[first.name])).toBe('first');
    expect(strFromU8(archive[renamed])).toBe('second');
  });

  it('reserves later original names while naming repeated files', async () => {
    const files = [
      textFile('a', 'svg', 'first'),
      textFile('a', 'svg', 'second'),
      textFile('a_2', 'svg', 'third'),
      textFile('a', 'svg', 'fourth')
    ];
    const archive = unzipSync((await bundleExportFiles('Pages', files)).bytes);
    expect(Object.keys(archive)).toEqual([
      'a.svg',
      'a_3.svg',
      'a_2.svg',
      'a_4.svg'
    ]);
    expect(Object.values(archive).map((bytes) => strFromU8(bytes))).toEqual([
      'first',
      'second',
      'third',
      'fourth'
    ]);
  });

  it('preserves distinct case and Unicode filename spellings', async () => {
    const names = [
      'Page.svg',
      'page.svg',
      'Résumé.svg',
      'Re\u0301sume\u0301.svg'
    ];
    const files = names.map((name, i) => ({
      name,
      format: 'svg' as const,
      bytes: new Uint8Array([i])
    }));
    const archive = unzipSync((await bundleExportFiles('Pages', files)).bytes);
    expect(Object.keys(archive)).toEqual(names);
    expect(Object.values(archive).map((bytes) => Array.from(bytes))).toEqual([
      [0],
      [1],
      [2],
      [3]
    ]);
  });
});
