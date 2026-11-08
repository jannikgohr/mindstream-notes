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

/** A file the user picked in the browser, written in chunks. */
export interface BrowserSaveFile {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  /** Discard what was written. Never throws. */
  abort(): Promise<void>;
}

interface WritableFile {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

type SaveFilePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{ createWritable(): Promise<WritableFile> }>;

/**
 * Ask where to save a file with the browser's File System Access picker, so
 * a large export can stream to disk instead of building up in memory.
 * Resolves `undefined` when the browser has no such picker and `null` when
 * the user cancels it. Call it straight from the click: browsers only open
 * the picker during a user gesture.
 */
export async function pickBrowserSaveFile(options: {
  suggestedName: string;
  description: string;
  mime: string;
  extension: string;
}): Promise<BrowserSaveFile | null | undefined> {
  const picker = (window as { showSaveFilePicker?: SaveFilePicker })
    .showSaveFilePicker;
  if (typeof picker !== 'function') return undefined;
  let writable: WritableFile;
  try {
    const handle = await picker.call(window, {
      suggestedName: options.suggestedName,
      types: [
        {
          description: options.description,
          accept: { [options.mime]: [options.extension] }
        }
      ]
    });
    writable = await handle.createWritable();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
  return {
    write: (chunk) => writable.write(chunk),
    close: () => writable.close(),
    abort: async () => {
      try {
        await writable.abort();
      } catch (err) {
        console.warn('[export] could not discard the partial file', err);
      }
    }
  };
}
