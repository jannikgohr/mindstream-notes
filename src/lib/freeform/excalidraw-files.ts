/**
 * Asset-backed file store for Excalidraw scenes.
 *
 * Excalidraw hands us images as `BinaryFileData` whose `dataURL` is a base64
 * data URL — often megabytes. Persisting those into the scene's Y.Doc would
 * put the bytes inside the note's `yrs_state`, which every sync then ships in
 * full. That is exactly what the `assets` table exists to avoid for markdown
 * and ink images, so freeform images go the same way: bytes live in `assets`,
 * and the Y.Doc holds only a {@link PersistedFileRef}.
 *
 * Uploads are fire-and-forget. `onRefsChanged` fires when a new reference
 * lands so the caller can schedule a Y.Doc flush; a file whose upload has not
 * finished is simply absent from the next flush and gets written by a later
 * one. That keeps the flush path synchronous.
 */

import { fetchDrawingAsset, uploadDrawingAsset } from '$lib/api/assets';
import type {
  BinaryFileData,
  BinaryFiles,
  DataURL
} from '@excalidraw/excalidraw/types';

/** What the Y.Doc stores in place of a file's bytes. */
export interface PersistedFileRef {
  assetId: string;
  mimeType: string;
  created: number;
  /** Excalidraw's own file version, kept so the write path can diff. */
  version?: number;
}

/**
 * Distinguishes a reference from a legacy inline `BinaryFileData`. Scenes
 * written before this change stored the whole file in the Y.Doc, and those
 * documents still exist.
 */
export function isPersistedFileRef(value: unknown): value is PersistedFileRef {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PersistedFileRef> & { dataURL?: unknown };
  return (
    typeof candidate.assetId === 'string' &&
    typeof candidate.mimeType === 'string' &&
    candidate.dataURL === undefined
  );
}

export function isLegacyInlineFile(value: unknown): value is BinaryFileData {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as BinaryFileData).dataURL === 'string'
  );
}

/** `data:<mime>;base64,<payload>` → raw bytes. Null for anything else. */
export function dataUrlToBytes(
  dataURL: string
): { bytes: number[]; mimeType: string } | null {
  const match = /^data:([^;,]*);base64,(.*)$/s.exec(dataURL);
  if (!match) return null;
  const [, mimeType, payload] = match;
  try {
    const binary = atob(payload);
    const bytes = new Array<number>(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, mimeType: mimeType || 'application/octet-stream' };
  } catch {
    return null;
  }
}

export function bytesToDataUrl(bytes: number[], mimeType: string): string {
  // Chunked: String.fromCharCode(...bytes) blows the argument limit on
  // anything larger than a small image.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.slice(i, i + CHUNK));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/** Fetch an asset and render it back as a base64 data URL. */
async function fetchDataUrl(assetId: string): Promise<string | null> {
  try {
    const asset = await fetchDrawingAsset(assetId);
    return bytesToDataUrl(asset.bytes, asset.mime_type);
  } catch (err) {
    console.warn('[freeform] image asset %s unavailable:', assetId, err);
    return null;
  }
}

/**
 * Turn stored entries into the `BinaryFiles` Excalidraw renders from,
 * inlining asset bytes. Legacy inline entries pass through untouched.
 *
 * `dataUrlFor` lets a caller supply a cached fetch; the default hits the
 * assets table each time, which is what a one-shot export wants.
 */
export async function inlineStoredFiles(
  stored: Record<string, PersistedFileRef | BinaryFileData>,
  dataUrlFor: (assetId: string) => Promise<string | null> = fetchDataUrl
): Promise<BinaryFiles> {
  const files: BinaryFiles = {};
  await Promise.all(
    Object.entries(stored).map(async ([fileId, value]) => {
      if (isLegacyInlineFile(value)) {
        files[fileId] = value;
        return;
      }
      if (!isPersistedFileRef(value)) return;
      const dataURL = await dataUrlFor(value.assetId);
      if (!dataURL) return;
      files[fileId] = {
        id: fileId as BinaryFileData['id'],
        dataURL: dataURL as DataURL,
        mimeType: value.mimeType as BinaryFileData['mimeType'],
        created: value.created,
        version: value.version
      };
    })
  );
  return files;
}

export interface ExcalidrawFileStoreOptions {
  noteId: string;
  /** Called when an upload completes and a new reference is available. */
  onRefsChanged?: () => void;
}

export class ExcalidrawFileStore {
  /** fileId → reference, for files whose bytes are in the assets table. */
  private readonly refs = new Map<string, PersistedFileRef>();
  /** fileIds with an upload in flight, so onChange storms don't re-upload. */
  private readonly uploading = new Set<string>();
  /** assetId → dataURL, so re-resolving a scene doesn't refetch bytes. */
  private readonly dataUrls = new Map<string, string>();
  private destroyed = false;

  constructor(private readonly opts: ExcalidrawFileStoreOptions) {}

  destroy(): void {
    this.destroyed = true;
  }

  /** Seed from what the Y.Doc already holds, so we don't re-upload. */
  adopt(refs: Record<string, PersistedFileRef>): void {
    for (const [fileId, ref] of Object.entries(refs)) {
      this.refs.set(fileId, ref);
    }
  }

  /** References for the files a scene currently uses, skipping any whose
   *  upload hasn't landed yet. */
  refsFor(fileIds: Iterable<string>): Record<string, PersistedFileRef> {
    const out: Record<string, PersistedFileRef> = {};
    for (const fileId of fileIds) {
      const ref = this.refs.get(fileId);
      if (ref) out[fileId] = ref;
    }
    return out;
  }

  /** True once every file in the scene has a reference. */
  hasAllRefs(files: BinaryFiles): boolean {
    return Object.keys(files).every((fileId) => this.refs.has(fileId));
  }

  /**
   * Upload any file we don't have a reference for. Fire-and-forget: callers
   * get told via `onRefsChanged`.
   */
  ensureUploaded(files: BinaryFiles): void {
    for (const [fileId, file] of Object.entries(files)) {
      if (this.refs.has(fileId) || this.uploading.has(fileId)) continue;
      if (!file?.dataURL) continue;
      this.uploading.add(fileId);
      void this.upload(fileId, file);
    }
  }

  private async upload(fileId: string, file: BinaryFileData): Promise<void> {
    try {
      const decoded = dataUrlToBytes(file.dataURL);
      if (!decoded) {
        console.warn(
          '[freeform] file %s is not a base64 data URL — not persisting',
          fileId
        );
        return;
      }
      const asset = await uploadDrawingAsset({
        owning_note_id: this.opts.noteId,
        mime_type: file.mimeType || decoded.mimeType,
        bytes: decoded.bytes
      });
      if (this.destroyed) return;
      this.refs.set(fileId, {
        assetId: asset.id,
        mimeType: asset.mime_type,
        created: file.created ?? Date.now(),
        version: file.version
      });
      this.dataUrls.set(asset.id, file.dataURL);
      this.opts.onRefsChanged?.();
    } catch (err) {
      console.warn('[freeform] failed to store image %s:', fileId, err);
    } finally {
      this.uploading.delete(fileId);
    }
  }

  /**
   * Resolve for the live editor: cached fetches, plus migration of any
   * legacy inline entry into the assets table on first sight.
   */
  async resolve(
    stored: Record<string, PersistedFileRef | BinaryFileData>
  ): Promise<BinaryFiles> {
    const files = await inlineStoredFiles(stored, (assetId) =>
      this.dataUrlFor(assetId)
    );

    const legacy: BinaryFiles = {};
    for (const [fileId, value] of Object.entries(stored)) {
      if (isLegacyInlineFile(value)) legacy[fileId] = value;
    }
    if (Object.keys(legacy).length > 0) this.ensureUploaded(legacy);
    return files;
  }

  private async dataUrlFor(assetId: string): Promise<string | null> {
    const cached = this.dataUrls.get(assetId);
    if (cached) return cached;
    try {
      const asset = await fetchDrawingAsset(assetId);
      const dataURL = bytesToDataUrl(asset.bytes, asset.mime_type);
      this.dataUrls.set(assetId, dataURL);
      return dataURL;
    } catch (err) {
      // A reference whose asset hasn't synced to this device yet. The image
      // renders as missing until sync catches up, which is the same
      // behaviour markdown image assets have.
      console.warn('[freeform] image asset %s unavailable:', assetId, err);
      return null;
    }
  }
}
