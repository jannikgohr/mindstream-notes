/**
 * Manifest canonicalization + checksum.
 *
 * A manifest's checksum lets the app detect when a plugin's declared surface
 * has *changed* since it was last approved. Canonicalization makes the checksum
 * stable regardless of key order or insignificant formatting, so two manifests
 * that describe the same contributions hash identically.
 *
 * NOTE: `checksumManifest` is a non-cryptographic drift checksum (FNV-1a), not
 * a security signature. It catches accidental or benign changes and gives the
 * integrity flow (backend accepted-hash comparison, later package signing) a
 * stable value to compare — it is NOT sufficient on its own to prove authorship
 * or resist tampering. That is the job of the signing work tracked separately.
 */

/**
 * Deterministic JSON string for a manifest: object keys sorted recursively,
 * `undefined` values dropped, array order preserved (order is semantically
 * meaningful for templates/commands, so it must affect the checksum).
 */
export function canonicalizeManifest(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

/** Stable FNV-1a (32-bit) hex checksum of the canonical manifest form. */
export function checksumManifest(value: unknown): string {
  return fnv1a(canonicalizeManifest(value));
}

function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // 32-bit FNV prime multiply via Math.imul to stay in int32 range.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
