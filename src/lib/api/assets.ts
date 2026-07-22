/**
 * Asset API. Mirror of src-tauri/src/assets/mod.rs.
 *
 * Assets are byte blobs (images, files) owned by notes. Each asset is
 * keyed by a client-generated UUID (`asset_<uuid>`) that's stable across
 * devices. Editors store app-owned asset URLs in note content / state, and
 * resolvers materialise them back into blob URLs via `fetchDrawingAsset`.
 *
 * Local-only for this slice — `dirty = 1` on insert, so when the
 * Etebase sync layer for assets ships (slice 2b), every existing row
 * gets pushed automatically.
 */

import {
  assertBoolean,
  assertNumber,
  assertNumberArray,
  assertRecord,
  assertString,
  TauriCommandName,
  invokeOrFallback
} from './core';
import { mockApi } from './mock-store';
import { parseNote, type Note } from './notes';

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
  return invokeOrFallback<Asset>(
    TauriCommandName.UploadDrawingAsset,
    { input },
    () => mockApi.uploadDrawingAsset(input),
    parseAsset
  );
}

export function fetchDrawingAsset(id: string): Promise<Asset> {
  return invokeOrFallback<Asset>(
    TauriCommandName.FetchDrawingAsset,
    { id },
    () => mockApi.fetchDrawingAsset(id),
    parseAsset
  );
}

export function importPdfNote(input: ImportPdfNoteInput): Promise<Note> {
  return invokeOrFallback<Note>(
    TauriCommandName.ImportPdfNote,
    { input },
    () => mockApi.importPdfNote(input),
    parseNote
  );
}

export function sweepUnreferencedMarkdownAssets(): Promise<number> {
  return invokeOrFallback<number>(
    TauriCommandName.SweepUnreferencedMarkdownAssets,
    {},
    () => Promise.resolve(0),
    (value) =>
      assertNumber(value, 'sweep_unreferenced_markdown_assets response')
  );
}

function parseAsset(value: unknown): Asset {
  const raw = assertRecord(value, 'asset');
  return {
    id: assertString(raw.id, 'asset.id'),
    owning_note_id: assertString(raw.owning_note_id, 'asset.owning_note_id'),
    mime_type: assertString(raw.mime_type, 'asset.mime_type'),
    size: assertNumber(raw.size, 'asset.size'),
    created: assertString(raw.created, 'asset.created'),
    modified: assertString(raw.modified, 'asset.modified'),
    pushed: assertBoolean(raw.pushed, 'asset.pushed'),
    bytes: assertNumberArray(raw.bytes, 'asset.bytes')
  };
}
