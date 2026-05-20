/**
 * Framework-neutral asset upload/resolve plumbing shared by the
 * markdown editor (Crepe / Milkdown) and the freeform editor
 * (tldraw / React).
 *
 * The shape on both sides is the same: a file gets uploaded to the
 * encrypted SQLite assets table via `uploadDrawingAsset`, embedded into
 * the document as an `asset:mindstream/<id>` URL, and resolved back to
 * a blob URL at render time via `fetchDrawingAsset`. The two editors
 * call slightly different methods (`onUpload` / `proxyDomURL` for
 * Crepe; `TLAssetStore.upload` / `TLAssetStore.resolve` for tldraw)
 * but both end up here.
 *
 * Per-editor instance: one bridge owns the blob-URL cache and disposes
 * it on unmount so we don't leak `URL.createObjectURL` references.
 *
 * Note-kind agnostic: both freeform and markdown notes use the same
 * `assets` table and the same FK back to `notes.id` — the Etebase
 * sync (slice 2b) doesn't care which kind owns the asset.
 */

import { fetchDrawingAsset, uploadDrawingAsset } from '$lib/api';

/**
 * URL scheme stored in document bodies (markdown `![alt](url)`, tldraw
 * `props.src`). Stable across devices because the asset id is
 * client-generated — sync uses `etebase_uid` for routing but the
 * public id never changes.
 */
export const ASSET_SCHEME = 'asset:mindstream/';

export interface AssetBridge {
  /** Upload a File and return its `asset:mindstream/<id>` URL. */
  uploadFile(file: File): Promise<string>;
  /** Translate a URL into one the browser can render. URLs we don't
   *  own (network http(s), data:, blob:) are returned unchanged. */
  resolveUrl(url: string): Promise<string> | string;
  /**
   * Drop cached blob URLs for the given asset IDs (without the
   * `asset:mindstream/` prefix). Used when sync has pulled fresh bytes
   * for an asset that was previously absent — eviction lets the next
   * resolveUrl call re-fetch from SQLite instead of returning the
   * stale pass-through. Keeps the bridge alive; revoke-and-clear only
   * touches matching entries.
   *
   * Returns the list of fully-qualified `asset:mindstream/<id>` URLs
   * that were actually in the resolved cache, so callers can kick the
   * matching DOM nodes / store records into re-rendering.
   */
  invalidate(ids: string[]): string[];
  /** Revoke ALL cached blob URLs. Call on editor unmount. */
  dispose(): void;
}

export function createAssetBridge(noteId: string): AssetBridge {
  // url → blob URL. Keyed by the full `asset:mindstream/<id>` so a
  // future asset:-flavoured source could share the cache without
  // colliding (just match on prefix in resolve).
  const resolved = new Map<string, string>();
  // De-duplicate concurrent resolves of the same URL — Crepe and
  // tldraw can both fire several resolveDomURL/resolve calls per render
  // for the same image when nodes refresh; we don't want N parallel
  // SQLite fetches + N blob URLs of the same bytes.
  const inflight = new Map<string, Promise<string>>();

  async function loadAssetBlob(id: string, url: string): Promise<string> {
    try {
      const asset = await fetchDrawingAsset(id);
      const blob = new Blob([new Uint8Array(asset.bytes)], {
        type: asset.mime_type
      });
      const blobUrl = URL.createObjectURL(blob);
      resolved.set(url, blobUrl);
      return blobUrl;
    } catch (err) {
      console.warn('[asset-bridge] fetch failed', url, err);
      // Returning the original URL is harmless — the browser will try
      // to load `asset:mindstream/…` and quietly fail with a broken
      // image, which is the same UX as a missing remote asset.
      return url;
    } finally {
      inflight.delete(url);
    }
  }

  return {
    async uploadFile(file: File): Promise<string> {
      // Tauri IPC takes a number array, not a File / ArrayBuffer.
      const buf = await file.arrayBuffer();
      const stored = await uploadDrawingAsset({
        owning_note_id: noteId,
        mime_type: file.type || 'application/octet-stream',
        bytes: Array.from(new Uint8Array(buf))
      });
      return `${ASSET_SCHEME}${stored.id}`;
    },

    resolveUrl(url: string): Promise<string> | string {
      // Pass-through for any URL we don't own.
      if (!url.startsWith(ASSET_SCHEME)) return url;
      const cached = resolved.get(url);
      if (cached) return cached;
      const pending = inflight.get(url);
      if (pending) return pending;
      const id = url.slice(ASSET_SCHEME.length);
      const p = loadAssetBlob(id, url);
      inflight.set(url, p);
      return p;
    },

    invalidate(ids: string[]): string[] {
      const evicted: string[] = [];
      for (const id of ids) {
        const url = `${ASSET_SCHEME}${id}`;
        const blobUrl = resolved.get(url);
        if (blobUrl) {
          URL.revokeObjectURL(blobUrl);
          resolved.delete(url);
          evicted.push(url);
        }
        // Also clear any in-flight resolves so a stale pass-through
        // promise can't win the race against a fresh fetch.
        inflight.delete(url);
      }
      return evicted;
    },

    dispose() {
      for (const blobUrl of resolved.values()) URL.revokeObjectURL(blobUrl);
      resolved.clear();
      inflight.clear();
    }
  };
}
