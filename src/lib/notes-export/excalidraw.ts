/**
 * Convert a freeform note's `yrs_state` into Excalidraw's standard
 * `.excalidraw` file format.
 *
 * The conversion reuses `readSceneFromYDoc` from the live editor's
 * adapter so the export and the on-screen view agree on what a scene
 * actually contains.
 */

import * as Y from 'yjs';
import { readSceneFromYDoc } from '$lib/freeform/excalidraw-yjs';
import { inlineStoredFiles } from '$lib/freeform/excalidraw-files';

export interface ExcalidrawFile {
  type: 'excalidraw';
  version: number;
  source: string;
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

/**
 * Hydrate the yjs Doc from the on-disk bytes, read the scene, and
 * wrap it in Excalidraw's standard top-level JSON shape. Returns
 * `null` if the byte array is empty (freshly-created freeform note
 * the user never drew on) — the caller can decide whether to skip
 * the file or write an empty scene.
 *
 * Async because image bytes live in the `assets` table, not in the scene:
 * a `.excalidraw` file has to carry them inline or it opens elsewhere with
 * broken images.
 */
export async function buildExcalidrawFile(
  yrsState: number[] | Uint8Array
): Promise<ExcalidrawFile | null> {
  const bytes =
    yrsState instanceof Uint8Array ? yrsState : new Uint8Array(yrsState);
  if (bytes.length === 0) return null;

  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, bytes);
  } catch (err) {
    // A corrupt yrs_state shouldn't take the whole export down. Let
    // the caller log + skip; returning null is the "nothing usable"
    // signal so it's distinct from "empty doc on purpose".
    console.warn(
      '[notes-export] could not decode yrs_state for freeform note',
      err
    );
    return null;
  }

  const snapshot = readSceneFromYDoc(doc);
  // Excalidraw's docs name `https://excalidraw.com` as the canonical
  // source string. Editors that bundle Excalidraw normally substitute
  // their own URL; using the canonical one keeps the file openable in
  // the public web app for free.
  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements: snapshot.elements as unknown[],
    appState: snapshot.appState as Record<string, unknown>,
    files: (await inlineStoredFiles(snapshot.storedFiles)) as Record<
      string,
      unknown
    >
  };
}
