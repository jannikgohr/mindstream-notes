/**
 * Drop inter-block whitespace from pasted HTML.
 *
 * ProseMirror parses a paste that carries its own slice metadata
 * (`data-pm-slice`, present on anything copied *out of* a ProseMirror editor)
 * with `preserveWhitespace: true`. Any newline or indentation sitting between
 * two block tags in that HTML therefore survives as a real text node, and
 * pasting onto an empty line turns it into a paragraph made of spaces — a
 * stray whitespace-only line in the markdown, right after the pasted text.
 *
 * A copy from another app carries no slice metadata, so it is parsed with
 * whitespace collapsing and never shows the problem. That asymmetry is the
 * whole bug: the same text pastes cleanly from Notepad++ and dirty from our
 * own editor, purely because of how the clipboard HTML got wrapped on the way
 * out (the Windows CF_HTML wrapper puts the fragment on its own line).
 *
 * Only whitespace *adjacent to a block element* is dropped. A whitespace text
 * node between two inline elements (`<em>a</em> <em>b</em>`) is a real space
 * and is left alone, as is anything inside `pre`/`code`.
 */

import { Plugin } from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';

const BLOCK_LEVEL = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'BODY',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'HTML',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL'
]);

function isBlock(element: Element | null): boolean {
  return !!element && BLOCK_LEVEL.has(element.tagName);
}

/**
 * Exported for tests: takes the clipboard HTML, returns it without the
 * whitespace-only text nodes that sit between block elements.
 */
export function stripInterBlockWhitespace(html: string): string {
  if (!html || !/>\s+</.test(html)) return html;

  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const walker = parsed.createTreeWalker(parsed.body, NodeFilter.SHOW_TEXT);
  const doomed: Text[] = [];

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (text.data.trim() !== '') continue;
    // Whitespace is content in preformatted contexts.
    if (text.parentElement?.closest('pre, code')) continue;

    const prev = text.previousElementSibling;
    const next = text.nextElementSibling;
    if (isBlock(prev) || isBlock(next)) {
      doomed.push(text);
      continue;
    }
    // A lone whitespace node directly inside a block container is the same
    // artifact with no element siblings to point at (`<body>\n  </body>`).
    if (!prev && !next && isBlock(text.parentElement)) doomed.push(text);
  }

  if (doomed.length === 0) return html;
  for (const text of doomed) text.remove();
  return parsed.body.innerHTML;
}

export const stripPastedInterBlockWhitespace = $prose(
  () =>
    new Plugin({
      props: {
        transformPastedHTML: (html: string) => stripInterBlockWhitespace(html)
      }
    })
);
