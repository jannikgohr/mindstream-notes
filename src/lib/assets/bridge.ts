/**
 * Framework-neutral asset upload/resolve plumbing for editor surfaces
 * that store app-owned asset URLs in their documents.
 *
 * The shape on both sides is the same: a file gets uploaded to the
 * encrypted SQLite assets table via `uploadDrawingAsset`, embedded into
 * the document as an `asset:mindstream/<id>` URL, and resolved back to
 * a URL the webview can actually load at render time.
 *
 * Under Tauri the webview can fetch those URLs natively — the Rust
 * side registers a `mindstream:` URI scheme handler (see
 * `serve_asset_bytes` in `src-tauri/src/lib.rs`). resolveUrl just
 * rewrites the stored `asset:mindstream/<id>` form to the
 * platform-specific URL the handler is reachable at. Synchronous, no
 * IPC round-trip, no blob URLs — which is what lets editor image
 * blocks set `<img src>` in one shot without the browser logging
 * `ERR_UNKNOWN_URL_SCHEME` against the original URL.
 *
 * Outside Tauri (Vite preview, SSR shells) the URI handler isn't
 * wired, so we fall through to fetching the bytes via IPC and minting
 * a blob URL on demand — the original implementation, kept as a
 * compatibility path.
 *
 * Per-editor instance: one bridge owns the (fallback) blob-URL cache
 * and disposes it on unmount so we don't leak `URL.createObjectURL`
 * references.
 *
 * Note-kind agnostic: both freeform and markdown notes use the same
 * `assets` table and the same FK back to `notes.id` — the Etebase
 * sync (slice 2b) doesn't care which kind owns the asset.
 */

import { fetchDrawingAsset, isTauri, uploadDrawingAsset } from '$lib/api';

/**
 * URL scheme stored in document bodies (for example markdown
 * `![alt](url)`). Stable across devices because the asset id is
 * client-generated — sync uses `etebase_uid` for routing but the
 * public id never changes.
 */
export const ASSET_SCHEME = 'asset:mindstream/';

/**
 * URI scheme name registered with Tauri. Must stay in sync with
 * `register_uri_scheme_protocol("mindstream", ...)` in
 * `src-tauri/src/lib.rs`.
 */
const TAURI_SCHEME = 'mindstream';

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
   * stale pass-through.
   *
   * Under Tauri there's nothing to evict (the URI handler reads from
   * SQLite on every request), so this just returns the list of
   * affected URLs so callers can still kick the matching DOM nodes /
   * store records into re-rendering.
   *
   * Returns the list of fully-qualified `asset:mindstream/<id>` URLs
   * the caller should treat as having changed.
   */
  invalidate(ids: string[]): string[];
  /** Revoke ALL cached blob URLs. Call on editor unmount. */
  dispose(): void;
}

/**
 * Map a stored `asset:mindstream/<id>` URL to a URL the webview can
 * fetch via the Tauri-side URI scheme handler.
 *
 * Tauri 2's webview rewrites custom schemes differently per platform:
 *   Windows / Android  → `http://<scheme>.localhost/<path>`
 *   macOS / Linux / iOS → `<scheme>://localhost/<path>`
 * Both rewrites land in the same Rust handler; we just have to emit
 * the form that platform expects so the request reaches it.
 */
function mapAssetUrlToWebview(url: string): string {
  const id = encodeURIComponent(url.slice(ASSET_SCHEME.length));
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/windows|android/i.test(ua)) {
    return `http://${TAURI_SCHEME}.localhost/${id}`;
  }
  return `${TAURI_SCHEME}://localhost/${id}`;
}

export function createAssetBridge(noteId: string): AssetBridge {
  // Fallback blob-URL cache used only when running outside Tauri. Keyed
  // by the full `asset:mindstream/<id>` so a future asset:-flavoured
  // source could share the cache without colliding (match on prefix).
  const resolved = new Map<string, string>();
  // De-duplicate concurrent resolves of the same URL. Editor image
  // nodes can request the same URL several times per render; we don't
  // want N parallel SQLite fetches + N blob URLs of the same bytes.
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
      if (isTauri()) return mapAssetUrlToWebview(url);
      // Non-Tauri fallback (Vite preview, SSR): blob URL via IPC.
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
      const affected: string[] = [];
      for (const id of ids) {
        const url = `${ASSET_SCHEME}${id}`;
        const blobUrl = resolved.get(url);
        if (blobUrl) {
          URL.revokeObjectURL(blobUrl);
          resolved.delete(url);
          affected.push(url);
        }
        // Also clear any in-flight resolves so a stale pass-through
        // promise can't win the race against a fresh fetch.
        inflight.delete(url);
        // Under Tauri there's no cache to flush, but callers still
        // want the URL list to drive DOM re-renders.
        if (isTauri() && !affected.includes(url)) affected.push(url);
      }
      return affected;
    },

    dispose() {
      for (const blobUrl of resolved.values()) URL.revokeObjectURL(blobUrl);
      resolved.clear();
      inflight.clear();
    }
  };
}
