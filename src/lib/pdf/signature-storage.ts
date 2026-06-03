/**
 * localStorage-backed signature library.
 *
 * Signatures are reusable across PDF notes (you draw your signature
 * once and re-apply it to anything you sign), so they live in the
 * browser's per-origin local storage rather than inside a single
 * note's Yjs state. The v1 schema stored a single signature under
 * `mindstream.pdf.signature.v1`; this module migrates that on first
 * read into an array under `mindstream.pdf.signatures.v1` and removes
 * the old key.
 */

import type { PdfSignatureSnapshot } from './types';

const STORAGE_KEY = 'mindstream.pdf.signatures.v1';
const LEGACY_STORAGE_KEY = 'mindstream.pdf.signature.v1';

/** Defensive load — silently returns [] if the entry is missing,
 *  malformed, or in an old shape we no longer recognise. */
export function loadReusableSignatures(): PdfSignatureSnapshot[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PdfSignatureSnapshot[];
      if (Array.isArray(parsed)) {
        return parsed
          .filter(
            (sig) => Array.isArray(sig?.strokes) && sig.strokes.length > 0
          )
          .map((sig) => ({ ...sig, id: sig.id ?? crypto.randomUUID() }));
      }
    }
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy) as PdfSignatureSnapshot;
      if (Array.isArray(parsed?.strokes) && parsed.strokes.length > 0) {
        const migrated: PdfSignatureSnapshot[] = [
          { ...parsed, id: crypto.randomUUID() }
        ];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        localStorage.removeItem(LEGACY_STORAGE_KEY);
        return migrated;
      }
    }
    return [];
  } catch {
    return [];
  }
}

export function persistReusableSignatures(
  signatures: PdfSignatureSnapshot[]
): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(signatures));
}
