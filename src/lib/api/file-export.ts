import { assertBoolean, invokeOrFallback, TauriCommandName } from './core';

export interface SaveFileExportArgs {
  suggestedName: string;
  dialogTitle?: string;
  bytes: Uint8Array;
  mime: string;
  filterName: string;
  extensions: string[];
}

/** Save through the native picker, or download in a browser. */
export async function saveFileExport(
  args: SaveFileExportArgs
): Promise<boolean> {
  return invokeOrFallback(
    TauriCommandName.SaveFileExport,
    {
      input: {
        suggestedName: args.suggestedName,
        dialogTitle: args.dialogTitle,
        bytes: Array.from(args.bytes),
        filterName: args.filterName,
        extensions: args.extensions
      }
    },
    () => {
      const url = URL.createObjectURL(
        new Blob([args.bytes.slice().buffer], { type: args.mime })
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = args.suggestedName;
      anchor.rel = 'noopener';
      document.body.append(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
      }
      return true;
    },
    (value) => assertBoolean(value, 'save_file_export response')
  );
}
