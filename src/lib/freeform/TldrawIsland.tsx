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
import {
  createAssetBridge,
  ASSET_SCHEME,
  type AssetBridge
} from '$lib/assets/bridge';
import { listen } from '$lib/api/events';

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

/**
 * Wrap a shared AssetBridge in tldraw's TLAssetStore shape. The actual
 * upload/resolve/cache logic lives in `$lib/assets/bridge` because the
 * markdown editor needs the same plumbing — only the call surfaces
 * differ (tldraw passes TLAsset wrappers; Crepe passes raw strings).
 */
function createAssetStore(bridge: AssetBridge): TLAssetStore {
  return {
    async upload(_asset: TLAsset, file: File): Promise<{ src: string }> {
      return { src: await bridge.uploadFile(file) };
    },

    resolve(asset: TLAsset) {
      const src = (asset.props as { src?: string | null }).src;
      if (!src) return null;
      // Pass-through for URLs we don't own (network images pasted in,
      // data: URLs). Tldraw fetches those itself.
      if (!src.startsWith(ASSET_SCHEME)) return src;
      return bridge.resolveUrl(src);
    }
  };
}

export default function TldrawIsland({
  yDoc,
  awareness: _awareness,
  readOnly,
  noteId
}: TldrawIslandProps) {
  // One bridge per note: holds the blob-URL cache + dispose. useMemo on
  // noteId keeps it stable across re-renders and rebuilds (with proper
  // dispose) only if noteId actually changes.
  const bridge = useMemo(() => createAssetBridge(noteId), [noteId]);
  useEffect(() => {
    return () => bridge.dispose();
  }, [bridge]);

  // The TLStore must live for the lifetime of this React subtree. useMemo
  // on `yDoc` recreates it if the prop ever swaps; the TLAssetStore is a
  // thin adapter around the bridge.
  const store: TLStore = useMemo(
    () =>
      createTLStore({
        shapeUtils: defaultShapeUtils,
        bindingUtils: defaultBindingUtils,
        // Asset upload/resolve is configured at store-construction time
        // (not on the <Tldraw> component) when a pre-made store is being
        // passed in.
        assets: createAssetStore(bridge)
      }),
    [yDoc, bridge]
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

  // Refresh tldraw asset shapes after a sync pulls fresh bytes for
  // assets the canvas already references. The flow:
  //   1. evict matching blob URLs from our bridge cache, so the next
  //      resolve hits SQLite (which now has the bytes)
  //   2. re-put each affected asset record into the store via
  //      mergeRemoteChanges — that's tldraw's idiomatic way to force
  //      its internal asset URL cache to re-call assetStore.resolve,
  //      which then returns the now-correct blob URL
  // Skipping `editor.store.put` when nothing's open is just an
  // optimisation; the effect re-subscribes whenever the editor /
  // bridge swap, so we never lose listener identity.
  useEffect(() => {
    const unlistenPromise = listen('sync-completed', (payload) => {
      const editor = editorRef.current;
      if (!editor || payload.assets_pulled_ids.length === 0) return;
      bridge.invalidate(payload.assets_pulled_ids);
      const targetUrls = new Set(
        payload.assets_pulled_ids.map((id) => `${ASSET_SCHEME}${id}`)
      );
      const affected = editor.store
        .allRecords()
        .filter(
          (r) =>
            r.typeName === 'asset' &&
            typeof (r as { props?: { src?: string } }).props?.src ===
              'string' &&
            targetUrls.has(
              (r as { props: { src: string } }).props.src
            )
        );
      if (affected.length === 0) return;
      editor.store.mergeRemoteChanges(() => {
        // Same record, same content — re-putting is enough to expire
        // tldraw's internal asset URL cache for these assetIds. The
        // image shape's `useImageOrVideoAsset` hook re-runs
        // resolveAssetUrl, which calls our bridge, which now succeeds.
        editor.store.put(affected);
      });
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [bridge]);

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
