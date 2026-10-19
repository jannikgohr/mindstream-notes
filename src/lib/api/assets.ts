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
  invokeOrFallback,
  optionalString
} from './core';
import { mockApi } from './mock-store';
import { parseNote, type Note } from './notes';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './core';

export interface AssetSummary {
  id: string;
  /**
   * The note that created this asset — an anchor, not a lifetime. An asset's
   * bytes are freed when nothing references it any more (Rust's `asset_refs`
   * table), so this is `null` for a blob whose creator was deleted while
   * another note still uses it.
   */
  owning_note_id: string | null;
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

export interface ImportInkPdfNoteInput extends ImportPdfNoteInput {
  asset_id: string;
  yrs_state: number[];
}

/** Transfer file bytes without expanding them into a JSON number array. */
async function invokeFile<T>(
  command: TauriCommandName,
  input: Record<string, unknown>,
  bytes: Uint8Array
): Promise<T> {
  const metadata = new TextEncoder().encode(JSON.stringify(input));
  const payload = new Uint8Array(4 + metadata.length + bytes.length);
  new DataView(payload.buffer).setUint32(0, metadata.length, true);
  payload.set(metadata, 4);
  payload.set(bytes, 4 + metadata.length);
  return invoke<T>(command, payload);
}

export async function uploadDrawingAssetBytes(
  input: Omit<UploadAssetInput, 'bytes'> & { bytes: Uint8Array }
): Promise<AssetSummary> {
  const { bytes, ...metadata } = input;
  if (!isTauri())
    return mockApi.uploadDrawingAsset({
      ...metadata,
      bytes: Array.from(bytes)
    });
  return parseAssetSummary(
    await invokeFile(TauriCommandName.UploadAssetBytes, metadata, bytes)
  );
}

export async function fetchAssetBytes(
  id: string,
  mimeType?: string
): Promise<Uint8Array> {
  if (!isTauri()) {
    const asset = await mockApi.fetchDrawingAsset(id);
    if (mimeType && asset.mime_type !== mimeType)
      throw new Error('Stored file has an unexpected type.');
    return new Uint8Array(asset.bytes);
  }
  // Mobile Tauri bridges may return a number array instead of an ArrayBuffer.
  return new Uint8Array(
    await invoke<ArrayBuffer | number[]>(TauriCommandName.FetchAssetBytes, {
      id,
      mimeType
    })
  );
}

export async function importPdfNoteBytes(
  input: Omit<ImportPdfNoteInput, 'bytes'> & { bytes: Uint8Array }
): Promise<Note> {
  const { bytes, ...metadata } = input;
  if (!isTauri())
    return mockApi.importPdfNote({ ...metadata, bytes: Array.from(bytes) });
  return parseNote(
    await invokeFile(TauriCommandName.ImportPdfNoteBytes, metadata, bytes)
  );
}

export function importInkPdfNote(input: ImportInkPdfNoteInput): Promise<Note> {
  return invokeOrFallback<Note>(
    TauriCommandName.ImportInkPdfNote,
    { input },
    () => mockApi.importInkPdfNote(input),
    parseNote
  );
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

function parseAssetSummary(value: unknown): AssetSummary {
  const raw = assertRecord(value, 'asset');
  return {
    id: assertString(raw.id, 'asset.id'),
    owning_note_id: optionalString(raw.owning_note_id, 'asset.owning_note_id'),
    mime_type: assertString(raw.mime_type, 'asset.mime_type'),
    size: assertNumber(raw.size, 'asset.size'),
    created: assertString(raw.created, 'asset.created'),
    modified: assertString(raw.modified, 'asset.modified'),
    pushed: assertBoolean(raw.pushed, 'asset.pushed')
  };
}

function parseAsset(value: unknown): Asset {
  const raw = assertRecord(value, 'asset');
  return {
    ...parseAssetSummary(value),
    bytes: assertNumberArray(raw.bytes, 'asset.bytes')
  };
}
