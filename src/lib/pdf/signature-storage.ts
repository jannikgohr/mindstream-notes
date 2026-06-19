/**
 * Reusable signature library — backed by the synced Rust store.
 *
 * Signatures are reusable across PDF notes (draw once, re-apply to anything
 * you sign) and now sync across the user's devices via Etebase, alongside
 * notes/folders/assets (see src-tauri/src/signatures + sync/mod.rs). They
 * previously lived in per-origin `localStorage`, so on first run this module
 * migrates any locally-stored signatures into the synced store and then
 * drops the old keys.
 *
 * On the wire a signature is a `SignatureRecord` whose `data` is the opaque
 * JSON geometry (`PdfSignatureSnapshot` minus its `id`); this module maps
 * between that and the `PdfSignatureSnapshot` the UI works with.
 */

import {
  listSignatures,
  saveSignature as apiSaveSignature,
  deleteSignature as apiDeleteSignature,
  type SignatureRecord
} from '$lib/api/signatures';
import type { PdfSignatureSnapshot } from './types';

// Pre-sync localStorage keys. v1 stored a single signature under
// LEGACY_SINGLE_KEY; a later migration moved it into an array under
// LEGACY_ARRAY_KEY. Both are read once, pushed to the synced store, then
// removed.
const LEGACY_ARRAY_KEY = 'mindstream.pdf.signatures.v1';
const LEGACY_SINGLE_KEY = 'mindstream.pdf.signature.v1';

function recordToSnapshot(rec: SignatureRecord): PdfSignatureSnapshot | null {
  try {
    const geom = JSON.parse(rec.data) as Omit<PdfSignatureSnapshot, 'id'>;
    if (!Array.isArray(geom?.strokes) || geom.strokes.length === 0) return null;
    return {
      id: rec.id,
      width: geom.width,
      height: geom.height,
      strokes: geom.strokes
    };
  } catch {
    return null;
  }
}

function snapshotToData(sig: PdfSignatureSnapshot): string {
  const { id: _id, ...geom } = sig;
  return JSON.stringify(geom);
}

/** Defensive read of the old localStorage shapes, mirroring the previous
 *  loader: skips entries without strokes, fills in a missing id. */
function readLegacySnapshots(): PdfSignatureSnapshot[] {
  if (typeof localStorage === 'undefined') return [];
  const out: PdfSignatureSnapshot[] = [];
  try {
    const raw = localStorage.getItem(LEGACY_ARRAY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PdfSignatureSnapshot[];
      if (Array.isArray(parsed)) {
        for (const sig of parsed) {
          if (Array.isArray(sig?.strokes) && sig.strokes.length > 0) {
            out.push({ ...sig, id: sig.id ?? crypto.randomUUID() });
          }
        }
      }
    }
    const legacy = localStorage.getItem(LEGACY_SINGLE_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy) as PdfSignatureSnapshot;
      if (Array.isArray(parsed?.strokes) && parsed.strokes.length > 0) {
        out.push({ ...parsed, id: parsed.id ?? crypto.randomUUID() });
      }
    }
  } catch {
    /* ignore malformed legacy data — nothing to migrate */
  }
  return out;
}

// Guard so the migration runs at most once per session even if several
// callers hit loadReusableSignatures() concurrently.
let migrationPromise: Promise<void> | null = null;

async function migrateLegacyOnce(): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  const hasLegacy =
    localStorage.getItem(LEGACY_ARRAY_KEY) !== null ||
    localStorage.getItem(LEGACY_SINGLE_KEY) !== null;
  if (!hasLegacy) return;

  // upsert is keyed by id and writes to the local DB synchronously (sync to
  // the server happens later), so this is safe offline and idempotent if a
  // later run repeats it.
  for (const sig of readLegacySnapshots()) {
    await apiSaveSignature({ id: sig.id, data: snapshotToData(sig) });
  }
  // Local writes landed — drop the old keys so we don't migrate again.
  localStorage.removeItem(LEGACY_ARRAY_KEY);
  localStorage.removeItem(LEGACY_SINGLE_KEY);
}

/** Migrate any legacy localStorage signatures (once), then return the
 *  synced library as UI snapshots. */
export async function loadReusableSignatures(): Promise<
  PdfSignatureSnapshot[]
> {
  if (!migrationPromise) {
    migrationPromise = migrateLegacyOnce().catch((err) => {
      // Leave the legacy keys in place so the next launch retries; fall
      // through to whatever the synced store already has.
      console.warn('[signatures] legacy migration failed', err);
    });
  }
  await migrationPromise;

  const records = await listSignatures();
  return records
    .map(recordToSnapshot)
    .filter((s): s is PdfSignatureSnapshot => s !== null);
}

export async function saveReusableSignature(
  sig: PdfSignatureSnapshot
): Promise<void> {
  await apiSaveSignature({ id: sig.id, data: snapshotToData(sig) });
}

export async function deleteReusableSignature(id: string): Promise<void> {
  await apiDeleteSignature(id);
}
