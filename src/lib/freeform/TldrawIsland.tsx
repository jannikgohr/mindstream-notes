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
 *
 * Yjs is the single source of truth — local edits flow into the Y.Doc
 * via the binding, the CollabProvider broadcasts them as opaque bytes,
 * the save trigger picks them up. Tldraw never talks to the network.
 *
 * Asset support is stubbed for this slice. Dropping an image into the
 * canvas will surface tldraw's "asset failed to load" state — loud and
 * obvious. The Etebase-backed upload/resolve lands in a follow-up.
 */

import {
  Tldraw,
  createTLStore,
  defaultShapeUtils,
  defaultBindingUtils,
  type Editor,
  type TLAssetStore,
  type TLStore
} from 'tldraw';
import 'tldraw/tldraw.css';
import { useEffect, useMemo, useRef } from 'react';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { bindStoreToYDoc, type BindHandle } from './tldraw-yjs';

export interface TldrawIslandProps {
  yDoc: Y.Doc;
  /** Reserved for the presence pass — not yet read. Kept on the prop so
   *  the Svelte shell can wire it now and the bridge can grow into it
   *  without an API change. */
  awareness: Awareness;
  /** Trashed notes mount read-only. */
  readOnly: boolean;
}

// Stubbed asset store. Slice 2 replaces these with Etebase-backed
// upload/fetch (one Etebase Item per asset, blob-URL cached in-memory
// on the resolve side). Keeping the surface here means slice 2 is a
// one-file change with no editor refactor.
//
// `upload` rejects loudly so the user sees a real error toast from
// tldraw instead of a silent no-op. `resolve` passes through the asset's
// own src (network URLs pasted into the canvas still work) — the
// follow-up will resolve `etebase://<uid>` URIs into blob URLs here.
const stubAssetStore: TLAssetStore = {
  async upload(): Promise<{ src: string }> {
    throw new Error(
      'Image / file upload is not yet implemented for freeform notes. ' +
        'Coming in a follow-up that wires uploads to the encrypted Etebase store.'
    );
  },
  resolve(asset) {
    const src = (asset.props as { src?: string | null }).src;
    return src ?? null;
  }
};

export default function TldrawIsland({
  yDoc,
  awareness: _awareness,
  readOnly
}: TldrawIslandProps) {
  // The TLStore must live for the lifetime of this React subtree. useMemo
  // on `yDoc` recreates it if the prop ever swaps (it shouldn't, but the
  // guard is cheap and makes a future "switch open notes without
  // unmount" optimisation safe).
  const store: TLStore = useMemo(
    () =>
      createTLStore({
        shapeUtils: defaultShapeUtils,
        bindingUtils: defaultBindingUtils,
        // Asset upload/resolve is configured at store-construction time
        // (not on the <Tldraw> component) when a pre-made store is being
        // passed in. Stub is errors-on-upload — see comment above.
        assets: stubAssetStore
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
