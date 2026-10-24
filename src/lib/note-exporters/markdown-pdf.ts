import type { Nodes } from 'mdast';
import type {
  Content,
  ContentText,
  TDocumentDefinitions
} from 'pdfmake/interfaces';
import {
  embedDocumentImages,
  nodeText,
  rasterImage,
  referencedImage,
  safeDocumentUrl,
  type MarkdownDocument
} from './document';

export async function documentPdf(doc: MarkdownDocument): Promise<Uint8Array> {
  await embedDocumentImages(doc);
  const [{ default: pdfMake }, { default: fonts }] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts')
  ]);
  pdfMake.addVirtualFileSystem(fonts);

  const images = new Map<
    string,
    Promise<Awaited<ReturnType<typeof rasterImage>>>
  >();
  function image(url: string) {
    let result = images.get(url);
    if (!result) {
      result = rasterImage(url);
      images.set(url, result);
    }
    return result;
  }

  function inline(
    node: Nodes,
    style: Partial<ContentText> = {}
  ): ContentText[] {
    if (node.type === 'text') return [{ text: node.value, ...style }];
    if (node.type === 'inlineCode')
      return [{ text: node.value, background: '#f4f4f4', ...style }];
    if (node.type === 'break') return [{ text: '\n', ...style }];
    if (node.type === 'image' || node.type === 'imageReference')
      return [{ text: node.alt ?? '', ...style }];
    if (node.type === 'html') return [];
    if ('children' in node) {
      const next = { ...style };
      if (node.type === 'strong') next.bold = true;
      if (node.type === 'emphasis') next.italics = true;
      if (node.type === 'delete') next.decoration = 'lineThrough';
      const url =
        node.type === 'link'
          ? node.url
          : node.type === 'linkReference'
            ? doc.definitions.get(node.identifier.toUpperCase())?.url
            : undefined;
      if (url && safeDocumentUrl(url)) {
        next.link = url;
        next.color = '#164c96';
      }
      return node.children.flatMap((child) => inline(child, next));
    }
    return [{ text: nodeText(node), ...style }];
  }

  async function block(node: Nodes): Promise<Content[]> {
    if (node.type === 'definition' || node.type === 'html') return [];
    if (node.type === 'paragraph') {
      const parts: Content[] = [];
      let text: ContentText[] = [];
      const flush = () => {
        if (text.length) parts.push({ text, margin: [0, 0, 0, 8] });
        text = [];
      };
      for (const child of node.children) {
        const img = referencedImage(child, doc);
        if (img) {
          flush();
          const rendered = await image(img.url);
          parts.push({
            image: rendered.data,
            fit: [475, 650],
            margin: [0, 0, 0, 8]
          });
        } else text.push(...inline(child));
      }
      flush();
      return parts;
    }
    if (node.type === 'heading')
      return [
        {
          text: inline(node),
          fontSize: [24, 20, 17, 15, 13, 12][node.depth - 1],
          bold: true,
          margin: [0, 12, 0, 6],
          headlineLevel: node.depth
        }
      ];
    if (node.type === 'code')
      return [
        {
          text: node.value || ' ',
          fontSize: 9,
          background: '#f4f4f4',
          margin: [0, 4, 0, 10],
          preserveLeadingSpaces: true
        }
      ];
    if (node.type === 'thematicBreak')
      return [
        {
          canvas: [
            {
              type: 'line',
              x1: 0,
              y1: 0,
              x2: 475,
              y2: 0,
              lineWidth: 0.5,
              lineColor: '#bbbbbb'
            }
          ],
          margin: [0, 8, 0, 8]
        }
      ];
    if (node.type === 'table')
      return [
        {
          table: {
            headerRows: 1,
            widths: node.children[0]?.children.map(() => '*') ?? [],
            body: node.children.map((row, index) =>
              row.children.map((cell, col) => ({
                text: inline(cell),
                bold: index === 0,
                alignment: node.align?.[col] ?? 'left',
                margin: [3, 3, 3, 3]
              }))
            )
          },
          layout: 'lightHorizontalLines',
          margin: [0, 4, 0, 10]
        }
      ];
    if (node.type === 'list') {
      const items = await Promise.all(
        node.children.map(async (item) => {
          const content = (await Promise.all(item.children.map(block))).flat();
          if (item.checked !== null && item.checked !== undefined)
            content.unshift({ text: item.checked ? '[x]' : '[ ]', bold: true });
          return {
            stack: content.length ? content : [' '],
            margin: [0, 0, 0, 4]
          } satisfies Content;
        })
      );
      return [
        node.ordered
          ? { ol: items, start: node.start ?? 1, margin: [0, 0, 0, 8] }
          : { ul: items, margin: [0, 0, 0, 8] }
      ];
    }
    if ('children' in node) {
      const children = (await Promise.all(node.children.map(block))).flat();
      return node.type === 'blockquote'
        ? [
            {
              stack: children,
              color: '#555555',
              margin: [16, 0, 0, 8],
              italics: true
            }
          ]
        : children;
    }
    return nodeText(node) ? [{ text: nodeText(node) }] : [];
  }

  const definition: TDocumentDefinitions = {
    info: { title: doc.title },
    pageSize: 'A4',
    pageMargins: [60, 50, 60, 50],
    defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.25 },
    content: [
      { text: doc.title, fontSize: 26, bold: true, margin: [0, 0, 0, 18] },
      ...(await Promise.all(doc.tree.children.map(block))).flat()
    ],
    footer: (page, pages) => ({
      text: `${page} / ${pages}`,
      alignment: 'center',
      fontSize: 9,
      margin: [0, 12, 0, 0]
    })
  };
  return new Uint8Array(await pdfMake.createPdf(definition).getBuffer());
}
