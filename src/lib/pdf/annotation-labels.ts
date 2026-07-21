/**
 * The human-readable labels an annotation overlay exposes to screen
 * readers.
 *
 * Pure functions over an annotation plus the viewer's current selection
 * and tool — no DOM, no host state — so the wording (and the truncation
 * rules for long comment bodies) can be asserted directly.
 */

import { tUi } from '$lib/settings/i18n.svelte';
import type { PdfAnnotation, PdfAnnotationType } from '$lib/pdf/types';
import type { PdfTool } from '$lib/pdf/viewer-helpers';

export function formatPdfUi(
  key: Parameters<typeof tUi>[0],
  replacements: Record<string, string | number>
): string {
  let value = tUi(key);
  for (const [name, replacement] of Object.entries(replacements)) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
}

export function annotationTypeLabel(type: PdfAnnotationType): string {
  switch (type) {
    case 'highlight':
      return tUi('pdf.annotation.type.highlight');
    case 'comment':
      return tUi('pdf.annotation.type.comment');
    case 'ink':
      return tUi('pdf.annotation.type.ink');
    case 'signature':
      return tUi('pdf.annotation.type.signature');
  }
}

export function accessibleCommentText(annotation: PdfAnnotation): string {
  const body = annotation.body?.replace(/\s+/g, ' ').trim();
  if (!body) return '';
  const comment = body.length > 140 ? `${body.slice(0, 137)}...` : body;
  return formatPdfUi('pdf.annotation.accessible.comment', { comment });
}

export function annotationAriaLabel(
  annotation: PdfAnnotation,
  rectIndex: number,
  rectCount: number,
  selectedAnnotationId: string | null,
  activeTool: PdfTool
): string {
  const part =
    rectCount > 1
      ? formatPdfUi('pdf.annotation.accessible.part', {
          part: rectIndex + 1,
          total: rectCount
        })
      : '';
  const state =
    annotation.id === selectedAnnotationId
      ? tUi('pdf.annotation.accessible.selected')
      : annotation.resolved
        ? tUi('pdf.annotation.accessible.resolved')
        : '';
  return formatPdfUi(
    activeTool === 'delete'
      ? 'pdf.annotation.accessible.delete'
      : 'pdf.annotation.accessible.select',
    {
      type: annotationTypeLabel(annotation.type),
      page: annotation.pageIndex + 1,
      part,
      state,
      comment: accessibleCommentText(annotation)
    }
  );
}
