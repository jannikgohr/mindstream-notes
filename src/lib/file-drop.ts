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
 *
 * A zone whose editor can't take the event as it arrived (the drop missed the
 * editor's own element, or the editor would read the wrong file) picks its
 * files with `filesClaimedByZone` and hands them on with `replayFileDrop`.
 */

/** Marks a drop zone. Value uses the `<input accept>` grammar. */
export const FILE_DROP_ACCEPT_ATTR = 'data-file-drop-accept';
/** Marks a zone that takes one file per drop: the first it accepts. */
export const FILE_DROP_SINGLE_ATTR = 'data-file-drop-single';

/** By MIME type, or by extension for the platforms that report no type. */
export const PDF_ACCEPT = 'application/pdf,.pdf';

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.jfif': 'image/jfif'
};

export const IMAGE_EXTENSIONS = Object.freeze(
  Object.keys(IMAGE_MIME_BY_EXTENSION)
);

/** Images Milkdown accepts, including the no-MIME desktop drag fallback. */
export const IMAGE_ACCEPT = ['image/*', ...IMAGE_EXTENSIONS].join(',');

/** Image formats Excalidraw 0.18 can insert on a canvas. */
export const EXCALIDRAW_IMAGE_ACCEPT = [
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/x-icon',
  'image/avif',
  'image/jfif',
  ...IMAGE_EXTENSIONS
].join(',');

/** Infer an image MIME type when the desktop drag event omitted it. */
export function inferredImageMimeType(file: File): string | null {
  const name = file.name.toLowerCase();
  const extension = IMAGE_EXTENSIONS.find((candidate) =>
    name.endsWith(candidate)
  );
  return extension ? IMAGE_MIME_BY_EXTENSION[extension] : null;
}

export function isImageFile(file: File): boolean {
  return (
    file.type.toLowerCase().startsWith('image/') ||
    inferredImageMimeType(file) !== null
  );
}

/** Give MIME-less or generically typed images a type before editor upload. */
export function normalizeImageFile(file: File): File {
  if (file.type.toLowerCase().startsWith('image/')) return file;
  const type = inferredImageMimeType(file);
  if (!type) return file;
  return new File([file], file.name, { type, lastModified: file.lastModified });
}

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
  /** The zone places one file per drop (Excalidraw). */
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

/**
 * The files a zone's own handler takes from a drop. A single-file zone takes
 * the first one it accepts, wherever that sits in the list: the order is the
 * drag source's, and a PDF listed ahead of an image must not cost the image.
 */
export function filesClaimedByZone(
  files: readonly File[],
  zone: FileDropZone | null
): File[] {
  if (!zone) return [];
  const accepted = files.filter((file) => fileMatchesAccept(file, zone.accept));
  return zone.single ? accepted.slice(0, 1) : accepted;
}

export function routeFileDrop(
  files: readonly File[],
  zone: FileDropZone | null
): FileDropRoute {
  const claimed = new Set(filesClaimedByZone(files, zone));
  const rest = files.filter((file) => !claimed.has(file));
  return {
    zoneClaims: claimed.size > 0,
    pdfs: rest.filter(isPdfFile),
    unusable: rest.filter((file) => !isPdfFile(file))
  };
}

const replayedDrops = new WeakSet<Event>();

/** True for a drop a zone dispatched itself through `replayFileDrop`. */
export function isReplayedFileDrop(event: Event): boolean {
  return replayedDrops.has(event);
}

/**
 * Dispatch a fresh `drop` on `target` that carries `files` and nothing else.
 *
 * The window router routes the replay like any other drop, so pass only what
 * the zone claimed: a PDF left in the list would be imported a second time.
 */
export function replayFileDrop(
  target: EventTarget,
  files: readonly File[],
  point: Pick<MouseEventInit, 'clientX' | 'clientY' | 'screenX' | 'screenY'>
): void {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  const replay = new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    dataTransfer: transfer,
    ...point
  });
  replayedDrops.add(replay);
  target.dispatchEvent(replay);
}

export interface FileDropRouterOptions {
  /**
   * PDFs no drop zone claimed. `alongsideZone` says the same drop also left
   * files with the zone under the pointer, whose editor is about to place
   * them and has to stay in front while it does.
   */
  importPdfs: (files: File[], alongsideZone: boolean) => void;
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
    if (route.pdfs.length > 0) options.importPdfs(route.pdfs, route.zoneClaims);
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
