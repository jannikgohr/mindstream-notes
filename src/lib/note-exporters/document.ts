import type { Note } from '$lib/api';
import { fetchDrawingAsset } from '$lib/api/assets';
import { bytesToDataUrl } from '$lib/freeform/excalidraw-files';
import { extractAssetIds } from '$lib/notes-export/markdown';
import type { Nodes, Root, Definition, Image as MarkdownImage } from 'mdast';

export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!
  );
}

export function safeDocumentUrl(url: string): boolean {
  // Ignore control bytes when checking schemes, as browsers do.
  // eslint-disable-next-line no-control-regex
  const compact = url.replace(/[\s\u0000-\u001f]/g, '');
  return (
    !/^[a-z][a-z0-9+.-]*:/i.test(compact) ||
    /^(https?:|mailto:|tel:)/i.test(compact)
  );
}

export async function inlineNoteAssets(body: string): Promise<string> {
  const urls = new Map<string, string>();
  for (const id of extractAssetIds(body)) {
    const asset = await fetchDrawingAsset(id);
    urls.set(id, bytesToDataUrl(asset.bytes, asset.mime_type));
  }
  return body.replace(
    /asset:mindstream\/([A-Za-z0-9_-]+)/g,
    (whole, id: string) => urls.get(id) ?? whole
  );
}

export function walkMarkdown(node: Nodes, visit: (node: Nodes) => void): void {
  visit(node);
  if ('children' in node)
    for (const child of node.children) walkMarkdown(child, visit);
}

export function nodeText(node: Nodes): string {
  if ('value' in node) return node.value;
  if (node.type === 'image' || node.type === 'imageReference')
    return node.alt ?? '';
  if ('children' in node) return node.children.map(nodeText).join('');
  return '';
}

export interface MarkdownDocument {
  title: string;
  tree: Root;
  definitions: Map<string, Definition>;
}

export function referencedImage(
  node: Nodes,
  doc: MarkdownDocument
): MarkdownImage | undefined {
  if (node.type === 'image') return node;
  if (node.type !== 'imageReference') return undefined;
  const definition = doc.definitions.get(node.identifier.toUpperCase());
  return definition
    ? {
        type: 'image',
        url: definition.url,
        alt: node.alt,
        title: definition.title
      }
    : undefined;
}

export async function parseDocument(
  note: Pick<Note, 'title' | 'body'>
): Promise<MarkdownDocument> {
  const [{ unified }, { default: remarkParse }, { default: remarkGfm }] =
    await Promise.all([
      import('unified'),
      import('remark-parse'),
      import('remark-gfm')
    ]);
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .parse(await inlineNoteAssets(note.body));
  const definitions = new Map<string, Definition>();
  walkMarkdown(tree, (node) => {
    if (node.type === 'definition')
      definitions.set(node.identifier.toUpperCase(), node);
  });
  return { title: note.title, tree, definitions };
}

async function imageDataUrl(url: string): Promise<string> {
  if (/^data:image\/(png|jpeg|gif|webp|svg\+xml|bmp);base64,/i.test(url))
    return url;
  if (!/^https?:\/\//i.test(url))
    throw new Error(`Cannot embed image: ${url.slice(0, 120)}`);
  return (await rasterImage(url)).data;
}

export async function embedDocumentImages(
  doc: MarkdownDocument
): Promise<void> {
  const sources = new Map<string, Promise<string>>();
  const pending: Promise<void>[] = [];
  walkMarkdown(doc.tree, (node) => {
    const image = referencedImage(node, doc);
    if (!image) return;
    let data = sources.get(image.url);
    if (!data) {
      data = imageDataUrl(image.url);
      sources.set(image.url, data);
    }
    pending.push(
      data.then((url) => {
        if (node.type === 'image') node.url = url;
        if (node.type === 'imageReference') {
          const definition = doc.definitions.get(node.identifier.toUpperCase());
          if (definition) definition.url = url;
        }
      })
    );
  });
  await Promise.all(pending);
}

export async function documentHtml(doc: MarkdownDocument): Promise<string> {
  await embedDocumentImages(doc);
  walkMarkdown(doc.tree, (node) => {
    if (
      (node.type === 'link' || node.type === 'definition') &&
      !safeDocumentUrl(node.url) &&
      !/^data:(image\/(png|jpeg|gif|webp|svg\+xml|bmp)|application\/pdf|text\/plain);base64,/i.test(
        node.url
      )
    )
      node.url = '';
  });
  const [{ unified }, { default: remarkRehype }, { default: rehypeStringify }] =
    await Promise.all([
      import('unified'),
      import('remark-rehype'),
      import('rehype-stringify')
    ]);
  const processor = unified().use(remarkRehype).use(rehypeStringify);
  const html = processor.stringify(await processor.run(doc.tree));
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(doc.title)}</title><style>
body{font:16px/1.6 system-ui,sans-serif;max-width:850px;margin:40px auto;padding:0 24px;color:black;background:white}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:whitesmoke}code{font-family:monospace}table{border-collapse:collapse;width:100%}th,td{border:1px solid silver;padding:8px;text-align:left}blockquote{border-left:3px solid silver;margin-left:0;padding-left:20px;color:dimgray}a{color:navy}@media print{body{margin:0;max-width:none}pre,blockquote,tr,img{break-inside:avoid}h1,h2,h3{break-after:avoid}}
</style></head><body><h1>${escapeHtml(doc.title)}</h1>\n${html}</body></html>\n`;
}

/** Normalize images to PNG so PDF and Word share format support and sizing. */
export async function rasterImage(
  url: string
): Promise<{ data: string; width: number; height: number }> {
  const image = new Image();
  if (/^https?:/i.test(url)) image.crossOrigin = 'anonymous';
  image.src = url;
  await image.decode();
  const scale = Math.min(
    1,
    2400 / Math.max(image.naturalWidth, image.naturalHeight)
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image export requires a canvas.');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return {
    data: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height
  };
}
