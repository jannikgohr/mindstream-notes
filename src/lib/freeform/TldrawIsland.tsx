/**
 * React island that hosts the `<Tldraw>` component. Created and mounted
 * from FreeformNoteEditor.svelte via dynamic `import()` so React + tldraw
 * (~750 KB gz combined) stay out of the main app bundle and only load
 * when a drawing note is opened.
 *
 * The Svelte shell owns:
 *   - the Y.Doc
 *   - the CollabProvider (the dumb relay socket)
 *   - persistence (debounced save to SQLite)
 *
 * This island owns:
 *   - the tldraw TLStore + its UI
 *   - the bidirectional store ↔ Y.Doc binding
 *   - the assetStore that routes uploads/resolves through the local
 *     SQLite assets table (and, once slice 2b ships, through Etebase
 *     for cross-device sync — the URL contract here doesn't change)
 *
 * Yjs is the single source of truth — local edits flow into the Y.Doc
 * via the binding, the CollabProvider broadcasts them as opaque bytes,
 * the save trigger picks them up. Tldraw never talks to the network.
 */

import {
  Tldraw,
  createTLStore,
  defaultShapeUtils,
  defaultBindingUtils,
  type Editor,
  type TLAsset,
  type TLAssetStore,
  type TLStore
} from 'tldraw';
import 'tldraw/tldraw.css';
import { useEffect, useMemo, useRef } from 'react';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { bindStoreToYDoc, type BindHandle } from './tldraw-yjs';
import { uploadDrawingAsset, fetchDrawingAsset } from '$lib/api';

export interface TldrawIslandProps {
  yDoc: Y.Doc;
  /** Reserved for the presence pass — not yet read. Kept on the prop so
   *  the Svelte shell can wire it now and the bridge can grow into it
   *  without an API change. */
  awareness: Awareness;
  /** Trashed notes mount read-only. */
  readOnly: boolean;
  /** Owning note id, threaded down so uploads can attribute the asset to
   *  the right freeform note. Needed by the SQLite FK constraint and by
   *  the eventual sync layer (assets travel with their note). */
  noteId: string;
}

/** Scheme that identifies asset URLs we own. Stable across devices because
 *  the asset id is a client-generated UUID, not a server-assigned uid —
 *  same pattern `notes.id` uses for its public identifier. */
const ASSET_SCHEME = 'mindstream-asset://';

/**
 * Build an asset store keyed to a specific note. Each freeform editor
 * instance has its own — the `noteId` closure makes uploads carry the
 * right owner without threading it through the tldraw API.
 *
 * Resolve caches blob URLs in a Map that lives as long as this assetStore
 * instance (i.e. as long as the editor is open). Closing the panel drops
 * the cache; we re-fetch from SQLite on the next open. URL.revokeObjectURL
 * runs on dispose so the browser can release the blob ref-counts.
 */
function createAssetStore(noteId: string): {
  store: TLAssetStore;
  dispose(): void;
} {
  // url → blob URL. We key by the FULL `mindstream-asset://<id>` URL
  // (not just `id`) so a future `etebase-asset://` scheme can slot in
  // without changing the cache shape.
  const resolved = new Map<string, string>();
  // Inflight fetches keyed by asset URL so two concurrent `resolve()`
  // calls for the same asset (e.g. duplicated shape) don't both hit
  // SQLite. Each resolve sees the same promise; once it lands, both
  // get the same blob URL.
  const inflight = new Map<string, Promise<string | null>>();

  const store: TLAssetStore = {
    async upload(_asset: TLAsset, file: File): Promise<{ src: string }> {
      // Tauri IPC doesn't accept a File; we have to drain it to bytes
      // first. arrayBuffer() reads the file once and resolves with the
      // raw buffer — same model as fetch().
      const buf = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buf));
      const stored = await uploadDrawingAsset({
        owning_note_id: noteId,
        mime_type: file.type || 'application/octet-stream',
        bytes
      });
      return { src: `${ASSET_SCHEME}${stored.id}` };
    },

    resolve(asset: TLAsset) {
      const src = (asset.props as { src?: string | null }).src;
      if (!src) return null;
      // Pass-through for URLs we don't own (e.g. images pasted from the
      // network). Tldraw will fetch those directly.
      if (!src.startsWith(ASSET_SCHEME)) return src;

      const cached = resolved.get(src);
      if (cached) return cached;

      const pending = inflight.get(src);
      if (pending) return pending;

      const id = src.slice(ASSET_SCHEME.length);
      const p = (async (): Promise<string | null> => {
        try {
          const asset = await fetchDrawingAsset(id);
          const blob = new Blob([new Uint8Array(asset.bytes)], {
            type: asset.mime_type
          });
          const blobUrl = URL.createObjectURL(blob);
          resolved.set(src, blobUrl);
          return blobUrl;
        } catch (err) {
          console.warn('[tldraw] resolve asset failed', src, err);
          return null;
        } finally {
          inflight.delete(src);
        }
      })();
      inflight.set(src, p);
      return p;
    }
  };

  return {
    store,
    dispose() {
      for (const url of resolved.values()) URL.revokeObjectURL(url);
      resolved.clear();
      inflight.clear();
    }
  };
}

export default function TldrawIsland({
  yDoc,
  awareness: _awareness,
  readOnly,
  noteId
}: TldrawIslandProps) {
  // Asset store is rebuilt whenever noteId changes (which is "never" in
  // practice — the React tree unmounts when the user switches notes —
  // but keeping it keyed makes the swap correct if dockview ever
  // reuses the panel without unmounting).
  const assetStoreRef = useRef<ReturnType<typeof createAssetStore> | null>(null);
  if (
    assetStoreRef.current === null ||
    (assetStoreRef.current as unknown as { __noteId?: string }).__noteId !==
      noteId
  ) {
    assetStoreRef.current?.dispose();
    const built = createAssetStore(noteId);
    // Tag with noteId so the swap-detection above stays accurate without
    // a separate ref. Light hack, but the alternative is two refs.
    (built as unknown as { __noteId: string }).__noteId = noteId;
    assetStoreRef.current = built;
  }
  useEffect(() => {
    // Drop the cache on unmount so blob URLs don't leak. Re-running on
    // every render is fine because dispose() is idempotent — but we
    // only want it on unmount, so the effect body is empty.
    return () => {
      assetStoreRef.current?.dispose();
      assetStoreRef.current = null;
    };
  }, []);

  // The TLStore must live for the lifetime of this React subtree. useMemo
  // on `yDoc` recreates it if the prop ever swaps; the assetStore is
  // pinned by ref so the memo doesn't need to depend on it.
  const store: TLStore = useMemo(
    () =>
      createTLStore({
        shapeUtils: defaultShapeUtils,
        bindingUtils: defaultBindingUtils,
        // Asset upload/resolve is configured at store-construction time
        // (not on the <Tldraw> component) when a pre-made store is being
        // passed in.
        assets: assetStoreRef.current!.store
      }),
    [yDoc]
  );

  // Bind store ↔ yDoc on mount, tear down on unmount. The bridge is
  // idempotent; calling destroy from useEffect cleanup is safe even if
  // React invoked the effect twice in dev/strict mode.
  const bindRef = useRef<BindHandle | null>(null);
  useEffect(() => {
    bindRef.current = bindStoreToYDoc({ yDoc, store });
    return () => {
      bindRef.current?.destroy();
      bindRef.current = null;
    };
  }, [yDoc, store]);

  // Track the editor instance so we can toggle read-only when the note
  // gets trashed mid-session. tldraw exposes this via the Tldraw
  // component's `onMount` callback rather than as a render prop.
  const editorRef = useRef<Editor | null>(null);
  useEffect(() => {
    editorRef.current?.updateInstanceState({ isReadonly: readOnly });
  }, [readOnly]);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Tldraw
        store={store}
        onMount={(editor) => {
          editorRef.current = editor;
          editor.updateInstanceState({ isReadonly: readOnly });
        }}
      />
    </div>
  );
}
