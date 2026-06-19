/**
 * Reusable signature library API. Mirror of src-tauri/src/signatures/mod.rs.
 *
 * Signatures sync across the user's devices via Etebase (one item per
 * signature). `data` is opaque JSON — the geometry of a
 * `PdfSignatureSnapshot` minus its `id` (`{ width, height, strokes[] }`).
 * The snapshot <-> record (de)serialisation lives in
 * $lib/pdf/signature-storage, which also migrates the old localStorage
 * library into this synced store on first run.
 */

import { invokeOrFallback } from './index';
import { mockApi } from './mock-store';

export interface SignatureRecord {
  id: string;
  data: string;
  created: string;
  modified: string;
  /** True once pushed to the remote (has an etebase_uid). */
  pushed: boolean;
}

export interface SaveSignatureInput {
  id: string;
  data: string;
}

export function listSignatures(): Promise<SignatureRecord[]> {
  return invokeOrFallback<SignatureRecord[]>('list_signatures', undefined, () =>
    mockApi.listSignatures()
  );
}

export function saveSignature(
  input: SaveSignatureInput
): Promise<SignatureRecord> {
  return invokeOrFallback<SignatureRecord>('save_signature', { input }, () =>
    mockApi.saveSignature(input)
  );
}

export function deleteSignature(id: string): Promise<void> {
  return invokeOrFallback<void>('delete_signature', { id }, () =>
    mockApi.deleteSignature(id)
  );
}
