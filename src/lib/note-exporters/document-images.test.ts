import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { strFromU8, unzipSync } from 'fflate';
import {
  documentHtml,
  embedDocumentImages,
  nodeText,
  parseDocument,
  rasterImage,
  referencedImage,
  safeDocumentUrl,
  type MarkdownDocument
} from './document';
import { documentDocx } from './markdown-docx';
import { documentPdf } from './markdown-pdf';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const drawImage = vi.fn();

beforeEach(() => {
  drawImage.mockReset();
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockResolvedValue(undefined);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(
    2400
  );
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(
    1200
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(PNG);
});
afterEach(() => vi.restoreAllMocks());

describe('document images and URLs', () => {
  it.each([
    'https://example.com',
    'http://example.com',
    'mailto:a@example.com',
    'tel:123',
    '#section',
    '../notes'
  ])('allows a document link to %s', (url) => {
    expect(safeDocumentUrl(url)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'java\nscript:alert(1)',
    'java\u0000script:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'file:///etc/passwd'
  ])('rejects an executable or local link to %s', (url) => {
    expect(safeDocumentUrl(url)).toBe(false);
  });

  it('embeds a remote image once when direct and reference images share its URL', async () => {
    const doc = await parseDocument({
      title: 'Images',
      body: '![Direct](https://example.com/chart.png) ![Reference][chart]\n\n[chart]: https://example.com/chart.png "Chart"'
    });
    const html = await documentHtml(doc);
    expect(html.match(/src="data:image\/png;base64,/g)).toHaveLength(2);
    expect(html).toContain('alt="Direct"');
    expect(html).toContain('title="Chart"');
    expect(HTMLImageElement.prototype.decode).toHaveBeenCalledOnce();
    const image = drawImage.mock.calls[0][0] as HTMLImageElement;
    expect(image.crossOrigin).toBe('anonymous');
    expect(image.src).toBe('https://example.com/chart.png');
    expect(doc.definitions.get('CHART')?.url).toBe(PNG);
  });

  it('keeps already embedded images without using the network or canvas', async () => {
    const doc = await parseDocument({
      title: 'Inline',
      body: `![Pixel](${PNG})`
    });
    await embedDocumentImages(doc);
    expect(drawImage).not.toHaveBeenCalled();
    expect(HTMLImageElement.prototype.decode).not.toHaveBeenCalled();
    expect(await documentHtml(doc)).toContain(PNG);
  });

  it.each([
    'file:///private/image.png',
    'ftp://example.com/image.png',
    'data:text/html;base64,PHNjcmlwdD4='
  ])('rejects an image source that cannot be embedded: %s', async (url) => {
    const doc = await parseDocument({
      title: 'Unsafe image',
      body: `![Image](${url})`
    });
    await expect(documentHtml(doc)).rejects.toThrow('Cannot embed image:');
    expect(drawImage).not.toHaveBeenCalled();
  });

  it.each([
    [4800, 1200, 2400, 600],
    [120, 80, 120, 80],
    [1, 1, 1, 1]
  ])(
    'rasterizes %s by %s images without enlarging them',
    async (width, height, expectedWidth, expectedHeight) => {
      vi.spyOn(
        HTMLImageElement.prototype,
        'naturalWidth',
        'get'
      ).mockReturnValue(width);
      vi.spyOn(
        HTMLImageElement.prototype,
        'naturalHeight',
        'get'
      ).mockReturnValue(height);
      expect(await rasterImage(PNG)).toEqual({
        data: PNG,
        width: expectedWidth,
        height: expectedHeight
      });
      expect(drawImage).toHaveBeenCalledWith(
        expect.any(HTMLImageElement),
        0,
        0,
        expectedWidth,
        expectedHeight
      );
      expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledWith(
        'image/png'
      );
    }
  );

  it('surfaces decoding and missing canvas errors', async () => {
    vi.mocked(HTMLImageElement.prototype.decode).mockRejectedValueOnce(
      new Error('CORS denied')
    );
    await expect(rasterImage('https://example.com/image.png')).rejects.toThrow(
      'CORS denied'
    );
    expect(drawImage).not.toHaveBeenCalled();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null);
    await expect(rasterImage(PNG)).rejects.toThrow('requires a canvas');
  });

  it('extracts readable fallback text and tolerates missing image definitions', () => {
    const doc: MarkdownDocument = {
      title: '',
      tree: { type: 'root', children: [] },
      definitions: new Map()
    };
    const image = {
      type: 'imageReference' as const,
      identifier: 'missing',
      referenceType: 'full' as const,
      alt: 'Unavailable chart'
    };
    expect(referencedImage(image, doc)).toBeUndefined();
    expect(nodeText(image)).toBe('Unavailable chart');
    expect(nodeText({ type: 'image', url: PNG })).toBe('');
    expect(
      nodeText({
        type: 'strong',
        children: [{ type: 'text', value: 'Readable' }]
      })
    ).toBe('Readable');
    expect(nodeText({ type: 'thematicBreak' })).toBe('');
  });
});

describe('rendered PDF and Word documents', () => {
  const body = `## Images and links

Before ![Chart](${PNG}) between ![Reference][chart] after.

[chart]: ${PNG} "Chart title"
[site]: https://example.com/reference

[Reference link][site] and [unsafe](javascript:alert%281%29) with \`inline code\`.  
Next line with <span>raw HTML</span>.

- [ ] Pending
- [x] Complete

1. First

   Another paragraph in the same item.

   > Nested quote

\`\`\`
first

last
\`\`\`
`;

  it('writes embedded Word images with scaled dimensions and reference hyperlinks', async () => {
    const archive = unzipSync(
      await documentDocx(
        await parseDocument({ title: 'Illustrated report', body })
      )
    );
    const xml = strFromU8(archive['word/document.xml']);
    const relationships = strFromU8(archive['word/_rels/document.xml.rels']);
    expect(xml.match(/<w:drawing>/g)).toHaveLength(2);
    expect(xml).toContain('cx="5715000" cy="2857500"');
    expect(xml).toContain('descr="Chart"');
    expect(xml).toContain('<w:br/>');
    expect(xml).toContain('Courier New');
    expect(xml).toContain('[ ] ');
    expect(xml).toContain('[x] ');
    expect(xml).not.toContain('&lt;span&gt;');
    expect(relationships).toContain('https://example.com/reference');
    expect(relationships).not.toContain('javascript:');
    const images = Object.keys(archive).filter((name) => name.endsWith('.png'));
    expect(images.length).toBeGreaterThan(0);
    expect(archive[images[0]]).toEqual(
      Uint8Array.from(atob(PNG.split(',')[1]), (c) => c.charCodeAt(0))
    );
    expect(HTMLImageElement.prototype.decode).toHaveBeenCalledOnce();
  });

  it('writes an illustrated PDF that can be reopened and has image resources', async () => {
    const pdf = await PDFDocument.load(
      await documentPdf(
        await parseDocument({ title: 'Illustrated report', body })
      )
    );
    expect(pdf.getTitle()).toBe('Illustrated report');
    const resources = pdf
      .getPage(0)
      .node.Resources()!
      .lookup(PDFName.of('XObject'), PDFDict);
    expect(resources.keys().length).toBeGreaterThan(0);
    expect(HTMLImageElement.prototype.decode).toHaveBeenCalledOnce();
  });

  it.each([documentPdf, documentDocx])(
    'rejects a document when an image fails to decode',
    async (render) => {
      vi.mocked(HTMLImageElement.prototype.decode).mockRejectedValue(
        new Error('Image unavailable')
      );
      const doc = await parseDocument({
        title: 'Broken image',
        body: `![Image](${PNG})`
      });
      await expect(render(doc)).rejects.toThrow('Image unavailable');
    }
  );
});
