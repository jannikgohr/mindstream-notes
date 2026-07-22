/**
 * Reusable signature library API. Mirror of src-tauri/src/signatures/mod.rs.
 *
 * Signatures sync across the user's devices via Etebase (one item per
 * signature). `data` is opaque JSON — the geometry of a
 * `PdfSignatureSnapshot` minus its `id` (`{ width, height, strokes[], image? }`).
 * The snapshot <-> record (de)serialisation lives in
 * $lib/pdf/signature-storage, which also migrates the old localStorage
 * library into this synced store on first run.
 */

import {
  assertBoolean,
  assertRecord,
  assertString,
  assertVoid,
  TauriCommandName,
  invokeOrFallback
} from './core';
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
  return invokeOrFallback<SignatureRecord[]>(
    TauriCommandName.ListSignatures,
    undefined,
    () => mockApi.listSignatures(),
    parseSignatureRecords
  );
}

export function saveSignature(
  input: SaveSignatureInput
): Promise<SignatureRecord> {
  return invokeOrFallback<SignatureRecord>(
    TauriCommandName.SaveSignature,
    { input },
    () => mockApi.saveSignature(input),
    parseSignatureRecord
  );
}

export function deleteSignature(id: string): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.DeleteSignature,
    { id },
    () => mockApi.deleteSignature(id),
    (value) => assertVoid(value, 'delete_signature response')
  );
}

function parseSignatureRecord(value: unknown): SignatureRecord {
  const raw = assertRecord(value, 'signature');
  return {
    id: assertString(raw.id, 'signature.id'),
    data: assertString(raw.data, 'signature.data'),
    created: assertString(raw.created, 'signature.created'),
    modified: assertString(raw.modified, 'signature.modified'),
    pushed: assertBoolean(raw.pushed, 'signature.pushed')
  };
}

function parseSignatureRecords(value: unknown): SignatureRecord[] {
  if (!Array.isArray(value))
    throw new Error('signatures response must be an array');
  return value.map(parseSignatureRecord);
}
