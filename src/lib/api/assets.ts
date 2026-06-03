/**
 * Asset API. Mirror of src-tauri/src/assets/mod.rs.
 *
 * Assets are byte blobs (images, files) attached to freeform notes. Each
 * asset is keyed by a client-generated UUID (`asset_<uuid>`) that's
 * stable across devices — the tldraw record store carries the
 * `mindstream-asset://<id>` URL inside the encrypted Yjs doc, and the
 * React island's resolver materialises it back into a blob URL via
 * `fetchDrawingAsset`.
 *
 * Local-only for this slice — `dirty = 1` on insert, so when the
 * Etebase sync layer for assets ships (slice 2b), every existing row
 * gets pushed automatically.
 */

import { invokeOrFallback } from './index';
import { mockApi } from './mock-store';
import type { Note } from './notes';

export interface AssetSummary {
  id: string;
  owning_note_id: string;
  mime_type: string;
  size: number;
  created: string;
  modified: string;
  pushed: boolean;
}

export interface Asset extends AssetSummary {
  /**
   * Raw file bytes. Tauri serialises Vec<u8> as a JS number array;
   * we round-trip that through a Uint8Array before handing to the
   * Blob constructor in the resolver. Wasteful for large blobs but
   * avoids a base64 hop; revisit if a real-world drawing trips the
   * IPC payload ceiling.
   */
  bytes: number[];
}

export interface UploadAssetInput {
  owning_note_id: string;
  mime_type: string;
  bytes: number[];
}

export interface ImportPdfNoteInput {
  title?: string;
  parent_collection_id?: string | null;
  bytes: number[];
}

export function uploadDrawingAsset(input: UploadAssetInput): Promise<Asset> {
  return invokeOrFallback<Asset>('upload_drawing_asset', { input }, () =>
    mockApi.uploadDrawingAsset(input)
  );
}

export function fetchDrawingAsset(id: string): Promise<Asset> {
  return invokeOrFallback<Asset>('fetch_drawing_asset', { id }, () =>
    mockApi.fetchDrawingAsset(id)
  );
}

export function importPdfNote(input: ImportPdfNoteInput): Promise<Note> {
  return invokeOrFallback<Note>('import_pdf_note', { input }, () =>
    mockApi.importPdfNote(input)
  );
}
