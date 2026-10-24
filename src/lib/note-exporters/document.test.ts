import { describe, expect, it, vi } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { parseDocument, documentHtml, inlineNoteAssets } from './document';
import { documentPdf } from './markdown-pdf';
import { documentDocx } from './markdown-docx';

vi.mock('$lib/api/assets', () => ({
  fetchDrawingAsset: vi.fn(async () => ({
    bytes: [1, 2, 3],
    mime_type: 'image/png'
  })),
  uploadDrawingAsset: vi.fn()
}));

const body =
  '# Heading\n\nHello **bold** and *italic* and ~~removed~~ with [link](https://example.com).\n\n3. First\n4. Second\n   - Nested\n\n- [x] Complete\n\n> A quote\n\n```js\nconst x = 1;\n```\n\n| Name | Value |\n| --- | ---: |\n| Café | 42 |\n\n---\n';

describe('Markdown document exports', () => {
  it('embeds stored assets into a standalone Markdown file', async () => {
    expect(await inlineNoteAssets('![image](asset:mindstream/asset_one)')).toBe(
      '![image](data:image/png;base64,AQID)'
    );
  });

  it('renders tables, tasks and formatting while dropping raw HTML and unsafe links', async () => {
    const doc = await parseDocument({
      title: '<script>title</script>',
      body:
        body + '\n<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)'
    });
    const html = await documentHtml(doc);
    expect(html).toContain('<table>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<del>removed</del>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('&lt;script&gt;title&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('Content-Security-Policy');
  });

  it('writes valid PDF bytes with a title, embedded fonts, and multiple pages for long documents', async () => {
    const bytes = await documentPdf(
      await parseDocument({
        title: 'Café résumé',
        body: body + '\n\nLong paragraph. '.repeat(3000)
      })
    );
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getTitle()).toBe('Café résumé');
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    expect(bytes.length).toBeGreaterThan(5000);
  }, 30000);

  it('writes Word paragraphs, tables, numbering, formatting and external links', async () => {
    const bytes = await documentDocx(
      await parseDocument({ title: 'Report', body })
    );
    const archive = unzipSync(bytes);
    const xml = strFromU8(archive['word/document.xml']);
    expect(xml).toContain('Report');
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('Heading1');
    expect(xml).toContain('<w:b/>');
    expect(xml).toContain('Café');
    expect(xml).toContain('const x = 1;');
    expect(strFromU8(archive['word/numbering.xml'])).toContain('w:val="3"');
    expect(strFromU8(archive['word/_rels/document.xml.rels'])).toContain(
      'https://example.com'
    );
  });
});
