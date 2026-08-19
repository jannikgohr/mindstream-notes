import type { PdfAnnotationType } from './types';
import type { PdfTool } from './viewer-helpers';

/** Whether an ink or signature annotation can be dragged with the active tool. */
export function annotationCanMove(
  type: PdfAnnotationType,
  activeTool: PdfTool,
  textMode: boolean
): boolean {
  if (type !== 'ink' && type !== 'signature') return false;
  return textMode || (type === 'signature' && activeTool === 'signature');
}
