import { isTauri } from './core';
import { saveFileNatively } from './export-session';

export interface SaveFileExportArgs {
  suggestedName: string;
  dialogTitle?: string;
  bytes: Uint8Array;
  mime: string;
  filterName: string;
  extensions: string[];
}

/** Hand a blob to the browser as a download. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}

/** Save through the native picker, or download in a browser. */
export async function saveFileExport(
  args: SaveFileExportArgs
): Promise<boolean> {
  if (!isTauri()) {
    downloadBlob(
      new Blob([args.bytes.slice().buffer], { type: args.mime }),
      args.suggestedName
    );
    return true;
  }
  return saveFileNatively({
    suggestedName: args.suggestedName,
    dialogTitle: args.dialogTitle,
    filterName: args.filterName,
    extensions: args.extensions,
    bytes: args.bytes
  });
}
