/**
 * Document outline (a.k.a. bookmarks / table of contents) support.
 *
 * pdf.js returns the outline as a nested tree whose leaves point at
 * "destinations" — either an explicit array (first element is a page
 * reference) or a named destination string that has to be resolved
 * first. The navigator sidebar wants a flat list with indentation depth
 * and a resolved page index per row, so we flatten and resolve up front.
 */

type PdfJs = typeof import('pdfjs-dist');
type PdfDocument = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;
type OutlineDocLike = Pick<
  PdfDocument,
  'getOutline' | 'getDestination' | 'getPageIndex'
>;
type OutlineNode = Awaited<ReturnType<PdfDocument['getOutline']>>[number];
type RefProxyArg = Parameters<PdfDocument['getPageIndex']>[0];

export type FlatOutlineItem = {
  id: string;
  title: string;
  /** 0-based nesting depth, for indentation. */
  depth: number;
  /** 0-based page index, or null when the entry has no usable destination. */
  pageIndex: number | null;
};

/**
 * Resolve an outline/link destination to a 0-based page index. Accepts
 * both explicit destination arrays and named-destination strings.
 * Returns null when the destination is absent or unresolvable.
 */
export async function resolveDestinationPageIndex(
  doc: OutlineDocLike,
  dest: string | unknown[] | null | undefined
): Promise<number | null> {
  if (dest == null) return null;
  try {
    const explicit =
      typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const ref = explicit[0];
    if (ref == null || typeof ref !== 'object') return null;
    return await doc.getPageIndex(ref as RefProxyArg);
  } catch {
    return null;
  }
}

/**
 * Load the document outline as a flat, depth-tagged list with resolved
 * page indices. Returns an empty array when the PDF has no outline.
 */
export async function loadFlatOutline(
  doc: OutlineDocLike
): Promise<FlatOutlineItem[]> {
  let tree: OutlineNode[] | null = null;
  try {
    tree = await doc.getOutline();
  } catch {
    tree = null;
  }
  if (!tree || tree.length === 0) return [];

  const out: FlatOutlineItem[] = [];
  let counter = 0;

  const walk = async (nodes: OutlineNode[], depth: number) => {
    for (const node of nodes) {
      const pageIndex = await resolveDestinationPageIndex(doc, node.dest);
      out.push({
        id: `outline-${counter++}`,
        title: node.title.trim() || '…',
        depth,
        pageIndex
      });
      if (node.items.length > 0) {
        await walk(node.items, depth + 1);
      }
    }
  };

  await walk(tree, 0);
  return out;
}
