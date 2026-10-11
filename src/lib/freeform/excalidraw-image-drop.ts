/**
 * Excalidraw exports can embed a complete scene in PNG and SVG metadata.
 * Its built-in drop handler loads that scene and replaces the open canvas.
 * Mindstream treats file drops as image insertion, so remove only the
 * Excalidraw payload and leave the rendered image bytes untouched.
 */

import { inferredImageMimeType, normalizeImageFile } from '$lib/file-drop';

const EXCALIDRAW_MIME = 'application/vnd.excalidraw+json';
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

function fileWithParts(file: File, parts: BlobPart[], type: string): File {
  return new File(parts, file.name, {
    type,
    lastModified: file.lastModified
  });
}

function pngChunkName(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset + 4]!,
    bytes[offset + 5]!,
    bytes[offset + 6]!,
    bytes[offset + 7]!
  );
}

function pngTextKeyword(
  bytes: Uint8Array,
  offset: number,
  length: number
): string {
  const start = offset + 8;
  const end = start + length;
  let separator = start;
  while (separator < end && bytes[separator] !== 0) separator += 1;
  return new TextDecoder('latin1').decode(bytes.subarray(start, separator));
}

async function stripPngScene(file: File): Promise<File> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (
    bytes.length < PNG_SIGNATURE.length ||
    !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
  ) {
    return file;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept: BlobPart[] = [file.slice(0, PNG_SIGNATURE.length)];
  let offset: number = PNG_SIGNATURE.length;
  let changed = false;

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return file;

    const name = pngChunkName(bytes, offset);
    const isSceneChunk =
      name === 'tEXt' &&
      pngTextKeyword(bytes, offset, length) === EXCALIDRAW_MIME;
    if (isSceneChunk) changed = true;
    else kept.push(file.slice(offset, end));

    offset = end;
    if (name === 'IEND') {
      if (offset < bytes.length) kept.push(file.slice(offset));
      break;
    }
  }

  return changed ? fileWithParts(file, kept, 'image/png') : file;
}

async function stripSvgScene(file: File): Promise<File> {
  const source = await file.text();
  if (!source.includes(`payload-type:${EXCALIDRAW_MIME}`)) return file;

  const clean = source.replace(
    /<!--\s*payload-type:application\/vnd\.excalidraw\+json\s*-->\s*(?:<!--\s*payload-version:\d+\s*-->\s*)?<!--\s*payload-start\s*-->[\s\S]*?<!--\s*payload-end\s*-->/gi,
    ''
  );
  return clean !== source
    ? fileWithParts(file, [clean], 'image/svg+xml')
    : file;
}

/**
 * Ready a dropped image for Excalidraw's own drop handler: no embedded scene
 * for it to load, and a MIME type for it to go by. When a desktop drag leaves
 * the type blank Excalidraw sniffs PNG, JPEG and GIF from the bytes and meets
 * every other format with an error dialog.
 */
export async function prepareDroppedImage(file: File): Promise<File> {
  return normalizeImageFile(await stripExcalidrawSceneMetadata(file));
}

export async function stripExcalidrawSceneMetadata(file: File): Promise<File> {
  const reportedType = file.type.toLowerCase();
  const type =
    reportedType === 'image/png' || reportedType === 'image/svg+xml'
      ? reportedType
      : inferredImageMimeType(file);
  if (type === 'image/png') return stripPngScene(file);
  if (type === 'image/svg+xml') return stripSvgScene(file);
  return file;
}
