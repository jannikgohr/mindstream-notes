/**
 * Bridge for the annotated-PDF save flow.
 *
 * Why this lives separately from the rest of `lib/api/*`: it has to
 * branch on `isTauri()`. In the app the bytes go through a native export
 * session, which pops the OS save dialog (so the user picks a folder +
 * filename, instead of the webview silently dropping the file in
 * ~/Downloads). In `pnpm dev` outside Tauri we fall back to a Blob +
 * `<a download>` anchor — works in any modern browser.
 */

import { isTauri } from './core';
import { saveFileNatively } from './export-session';

export interface SavePdfExportArgs {
  /** Suggested filename pre-filled into the dialog (no extension stripped). */
  suggestedName: string;
  /** Optional native save-dialog title. */
  dialogTitle?: string;
  /** Bytes to write. */
  bytes: Uint8Array;
}

/**
 * Returns `true` if the file was written, `false` if the user cancelled
 * the dialog. Throws on actual IO / dialog errors.
 */
export async function saveAnnotatedPdf(
  args: SavePdfExportArgs
): Promise<boolean> {
  if (!isTauri()) return downloadViaAnchor(args);
  return saveFileNatively({
    suggestedName: args.suggestedName,
    dialogTitle: args.dialogTitle,
    filterName: 'PDF',
    extensions: ['pdf'],
    bytes: args.bytes
  });
}

function downloadViaAnchor(args: SavePdfExportArgs): boolean {
  // Slice forces Blob to own its own ArrayBuffer; otherwise a later
  // GC of `bytes` can surprise the download mid-write on some webviews.
  const blob = new Blob([args.bytes.slice().buffer], {
    type: 'application/pdf'
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = args.suggestedName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  // We can't tell whether the browser actually saved or cancelled;
  // optimistically report success.
  return true;
}

// Re-export so callers can branch on the environment if they need to.
export { isTauri };
