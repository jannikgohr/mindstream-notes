import {
  assertBoolean,
  invokeOrFallback,
  isTauri,
  TauriCommandName
} from './core';

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
  return invokeOrFallback(
    TauriCommandName.SaveFileExport,
    // Tauri needs a number array, one element per byte. A browser never sends
    // it, and for a large file building it could cost the tab its memory.
    isTauri()
      ? {
          input: {
            suggestedName: args.suggestedName,
            dialogTitle: args.dialogTitle,
            bytes: Array.from(args.bytes),
            filterName: args.filterName,
            extensions: args.extensions
          }
        }
      : undefined,
    () => {
      downloadBlob(
        new Blob([args.bytes.slice().buffer], { type: args.mime }),
        args.suggestedName
      );
      return true;
    },
    (value) => assertBoolean(value, 'save_file_export response')
  );
}
