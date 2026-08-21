/**
 * Paragraph segmentation, shared by every syntax.
 *
 * Blank lines separate paragraphs in Markdown, in Typst and in a plain
 * textarea alike, so this is one implementation rather than three — the
 * syntaxes differ in what they ignore, not in where a paragraph ends.
 */

import type { Segment } from '../types';

/**
 * Cut text into paragraph-sized segments on blank lines.
 *
 * Per-paragraph rather than per-document so the bus's cache does useful
 * work: editing one paragraph re-checks one paragraph. Per-LINE would
 * segment more finely still, but it would break any checker that needs a
 * whole sentence — grammar rules, and LanguageTool in particular — since a
 * sentence wrapped across two lines would be checked as two fragments.
 */
export function splitParagraphs(text: string): Segment[] {
  const segments: Segment[] = [];
  const lines = text.split('\n');

  let offset = 0;
  let start = -1;
  let end = -1;

  const flush = () => {
    if (start === -1) return;
    segments.push({ text: text.slice(start, end), from: start, to: end });
    start = -1;
  };

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;

    if (line.trim().length === 0) {
      flush();
      continue;
    }
    if (start === -1) start = lineStart;
    end = lineStart + line.length;
  }
  flush();

  return segments;
}
