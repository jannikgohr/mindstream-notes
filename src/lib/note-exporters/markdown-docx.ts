import type { Nodes } from 'mdast';
import { base64ToBytes } from '$lib/editor/base64';
import {
  embedDocumentImages,
  nodeText,
  rasterImage,
  referencedImage,
  safeDocumentUrl,
  type MarkdownDocument
} from './document';
import type { IRunOptions, ParagraphChild, Paragraph, Table } from 'docx';

export async function documentDocx(doc: MarkdownDocument): Promise<Uint8Array> {
  await embedDocumentImages(doc);
  const lib = await import('docx');
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    ImageRun,
    Table,
    TableRow,
    TableCell,
    ExternalHyperlink,
    HeadingLevel,
    WidthType,
    LevelFormat
  } = lib;
  const images = new Map<
    string,
    Promise<Awaited<ReturnType<typeof rasterImage>>>
  >();
  async function inline(
    node: Nodes,
    style: IRunOptions = {}
  ): Promise<ParagraphChild[]> {
    const img = referencedImage(node, doc);
    if (img) {
      let pending = images.get(img.url);
      if (!pending) {
        pending = rasterImage(img.url);
        images.set(img.url, pending);
      }
      const rendered = await pending;
      const scale = Math.min(1, 600 / rendered.width, 850 / rendered.height);
      return [
        new ImageRun({
          type: 'png',
          data: base64ToBytes(rendered.data.split(',')[1]),
          transformation: {
            width: Math.round(rendered.width * scale),
            height: Math.round(rendered.height * scale)
          },
          altText: {
            title: img.alt ?? '',
            description: img.alt ?? '',
            name: img.alt ?? 'Image'
          }
        })
      ];
    }
    if (node.type === 'text')
      return [new TextRun({ ...style, text: node.value })];
    if (node.type === 'inlineCode')
      return [new TextRun({ ...style, text: node.value, font: 'Courier New' })];
    if (node.type === 'break') return [new TextRun({ break: 1 })];
    if (node.type === 'html') return [];
    if ('children' in node) {
      const next = { ...style };
      if (node.type === 'strong') next.bold = true;
      if (node.type === 'emphasis') next.italics = true;
      if (node.type === 'delete') next.strike = true;
      const children = (
        await Promise.all(node.children.map((child) => inline(child, next)))
      ).flat();
      const url =
        node.type === 'link'
          ? node.url
          : node.type === 'linkReference'
            ? doc.definitions.get(node.identifier.toUpperCase())?.url
            : undefined;
      return url && safeDocumentUrl(url)
        ? [new ExternalHyperlink({ link: url, children })]
        : children;
    }
    return nodeText(node)
      ? [new TextRun({ ...style, text: nodeText(node) })]
      : [];
  }

  let listId = 0;
  const numbering: {
    reference: string;
    levels: import('docx').ILevelsOptions[];
  }[] = [];
  async function blocks(
    node: Nodes,
    depth = 0
  ): Promise<(Paragraph | Table)[]> {
    if (node.type === 'html' || node.type === 'definition') return [];
    if (node.type === 'paragraph' || node.type === 'heading') {
      const heading =
        node.type === 'heading'
          ? [
              HeadingLevel.HEADING_1,
              HeadingLevel.HEADING_2,
              HeadingLevel.HEADING_3,
              HeadingLevel.HEADING_4,
              HeadingLevel.HEADING_5,
              HeadingLevel.HEADING_6
            ][node.depth - 1]
          : undefined;
      return [
        new Paragraph({
          children: (
            await Promise.all(node.children.map((child) => inline(child)))
          ).flat(),
          heading,
          spacing: { after: 160 }
        })
      ];
    }
    if (node.type === 'code')
      return node.value.split('\n').map(
        (text) =>
          new Paragraph({
            children: [
              new TextRun({
                text: text || ' ',
                font: 'Courier New',
                size: 18
              })
            ],
            spacing: { after: 0 }
          })
      );
    if (node.type === 'thematicBreak')
      return [new Paragraph({ thematicBreak: true })];
    if (node.type === 'table')
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: await Promise.all(
            node.children.map(
              async (row, index) =>
                new TableRow({
                  tableHeader: index === 0,
                  children: await Promise.all(
                    row.children.map(
                      async (cell) =>
                        new TableCell({
                          children: [
                            new Paragraph({
                              children: (
                                await Promise.all(
                                  cell.children.map((child) =>
                                    inline(child, { bold: index === 0 })
                                  )
                                )
                              ).flat()
                            })
                          ]
                        })
                    )
                  )
                })
            )
          )
        })
      ];
    if (node.type === 'list') {
      const reference = `list-${listId++}`;
      const level = Math.min(depth, 8);
      numbering.push({
        reference,
        levels: Array.from({ length: 9 }, (_, index) => ({
          level: index,
          format: node.ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
          text: node.ordered ? `%${index + 1}.` : '•',
          start: node.start ?? 1,
          style: {
            paragraph: { indent: { left: 360 * (index + 1), hanging: 180 } }
          }
        }))
      });
      const result: (Paragraph | Table)[] = [];
      for (const item of node.children) {
        let first = true;
        for (const child of item.children) {
          if (first && child.type === 'paragraph') {
            const children = (
              await Promise.all(child.children.map((part) => inline(part)))
            ).flat();
            if (item.checked !== null && item.checked !== undefined)
              children.unshift(new TextRun(item.checked ? '[x] ' : '[ ] '));
            result.push(
              new Paragraph({
                children,
                numbering: { reference, level },
                spacing: { after: 100 }
              })
            );
          } else result.push(...(await blocks(child, depth + 1)));
          first = false;
        }
      }
      return result;
    }
    if ('children' in node) {
      const result = (
        await Promise.all(node.children.map((child) => blocks(child, depth)))
      ).flat();
      return result;
    }
    return [];
  }
  const children = [
    new Paragraph({ text: doc.title, heading: HeadingLevel.TITLE }),
    ...(await Promise.all(doc.tree.children.map((node) => blocks(node)))).flat()
  ];
  const document = new Document({
    title: doc.title,
    numbering: { config: numbering },
    sections: [{ children }]
  });
  return new Uint8Array(await Packer.toArrayBuffer(document));
}
