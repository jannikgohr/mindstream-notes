/**
 * Routing for files dragged in from outside the app.
 *
 * Tauri's own file-drop interception is off (`dragDropEnabled: false`), so the
 * webview sees plain HTML5 drag events and, like any browser, navigates to a
 * dropped file unless both `dragover` and `drop` are cancelled. Something has
 * to cancel every file drop, and the same something has to decide who gets the
 * files:
 *
 *   1. A *drop zone* under the pointer — an element carrying
 *      `data-file-drop-accept`, listing what its own drop handler can use (the
 *      markdown editor takes images, the file tree takes PDFs). When the zone
 *      accepts at least one of the dropped files the event is left alone and
 *      the zone handles it.
 *   2. PDFs no zone claimed go to `importPdfs`, which turns them into notes.
 *   3. A drop nobody could use at all is reported through `onUnusable`.
 *
 * The decision is made in the capture phase, before any zone sees the event,
 * because the editors can't be relied on to turn away what they can't use:
 * Milkdown's upload plugin claims every file drop and then discards whatever
 * isn't an image, and Excalidraw answers a non-image with an error dialog.
 */

/** Marks a drop zone. Value uses the `<input accept>` grammar. */
export const FILE_DROP_ACCEPT_ATTR = 'data-file-drop-accept';
/** Marks a zone whose handler only ever reads the first dropped file. */
export const FILE_DROP_SINGLE_ATTR = 'data-file-drop-single';

/** By MIME type, or by extension for the platforms that report no type. */
export const PDF_ACCEPT = 'application/pdf,.pdf';
export const IMAGE_ACCEPT = 'image/*';

/** True when an HTML drag carries files from outside the app. */
export function isFileDrag(event: DragEvent): boolean {
  const transfer = event.dataTransfer;
  return Boolean(
    transfer &&
    (transfer.files.length > 0 || Array.from(transfer.types).includes('Files'))
  );
}

export function isPdfFile(file: File): boolean {
  return (
    file.type.toLowerCase() === 'application/pdf' ||
    file.name.toLowerCase().endsWith('.pdf')
  );
}

export function droppedFiles(event: DragEvent): File[] {
  return Array.from(event.dataTransfer?.files ?? []);
}

/** Files that the app can import as notes. */
export function droppedPdfFiles(event: DragEvent): File[] {
  return droppedFiles(event).filter(isPdfFile);
}

/**
 * `accept` tokens follow `<input accept>`: a wildcard MIME type (`image/*`),
 * an exact one (`application/pdf`), or an extension (`.pdf`).
 */
export function fileMatchesAccept(
  file: File,
  accept: readonly string[]
): boolean {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return accept.some((token) => {
    if (token.startsWith('.')) return name.endsWith(token);
    if (token.endsWith('/*')) return type.startsWith(token.slice(0, -1));
    return type === token;
  });
}

export interface FileDropZone {
  accept: string[];
  /** The zone's handler reads only the first file (Excalidraw). */
  single: boolean;
}

/** The innermost drop zone containing `target`, if any. */
export function fileDropZoneFor(
  target: EventTarget | null
): FileDropZone | null {
  // WebKit can report a text node as the target of a drag event.
  const element =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  const zone = element?.closest(`[${FILE_DROP_ACCEPT_ATTR}]`);
  if (!zone) return null;
  const accept = (zone.getAttribute(FILE_DROP_ACCEPT_ATTR) ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (accept.length === 0) return null;
  return { accept, single: zone.hasAttribute(FILE_DROP_SINGLE_ATTR) };
}

export interface FileDropRoute {
  /** The zone under the pointer takes the event as it is. */
  zoneClaims: boolean;
  /** PDFs the zone didn't claim — to be imported as notes. */
  pdfs: File[];
  /** Files neither the zone nor the PDF import can use. */
  unusable: File[];
}

export function routeFileDrop(
  files: readonly File[],
  zone: FileDropZone | null
): FileDropRoute {
  // A single-file zone never looks past the first file, so it can't claim on
  // the strength of a later one: it would read the first and choke on it.
  const offered = zone ? (zone.single ? files.slice(0, 1) : files) : [];
  const claimed = new Set(
    zone ? offered.filter((file) => fileMatchesAccept(file, zone.accept)) : []
  );
  const rest = files.filter((file) => !claimed.has(file));
  return {
    zoneClaims: claimed.size > 0,
    pdfs: rest.filter(isPdfFile),
    unusable: rest.filter((file) => !isPdfFile(file))
  };
}

export interface FileDropRouterOptions {
  /** PDFs no drop zone claimed. */
  importPdfs: (files: File[]) => void;
  /** The drop held nothing any target could use. */
  onUnusable: (files: File[]) => void;
}

/** Install the window-level routing described above. Returns the teardown. */
export function installFileDropRouter(
  target: Window,
  options: FileDropRouterOptions
): () => void {
  const onDragOver = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    // The browser only fires `drop` on a target whose `dragover` was
    // cancelled; without this it navigates to the file instead.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    // A zone needs the event for its own feedback (drop cursor, row
    // highlight). Nothing outside one has any business with a file drag.
    if (!fileDropZoneFor(event.target)) event.stopPropagation();
  };

  const onDrop = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    const route = routeFileDrop(
      droppedFiles(event),
      fileDropZoneFor(event.target)
    );
    if (!route.zoneClaims) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (route.pdfs.length > 0) options.importPdfs(route.pdfs);
    else if (!route.zoneClaims) options.onUnusable(route.unusable);
  };

  // A zone that claimed a drop and then didn't handle it (an editor that went
  // read-only mid-drag) must still not let the webview navigate away.
  const onUnhandledDrop = (event: DragEvent) => {
    if (isFileDrag(event) && !event.defaultPrevented) event.preventDefault();
  };

  target.addEventListener('dragover', onDragOver, true);
  target.addEventListener('drop', onDrop, true);
  target.addEventListener('drop', onUnhandledDrop);
  return () => {
    target.removeEventListener('dragover', onDragOver, true);
    target.removeEventListener('drop', onDrop, true);
    target.removeEventListener('drop', onUnhandledDrop);
  };
}
