/**
 * Yjs scene adapter for Excalidraw-backed freeform notes — local
 * persistence only.
 *
 * Live collaboration for freeform notes goes over excalidraw-room (see
 * excalidraw-room-client.ts), not Yjs. This module's job is narrower
 * now: keep the local Y.Doc in step with what Excalidraw is drawing so
 * the FreeformNoteEditor can serialise it as `yrs_state` into etebase
 * (and load it back unchanged on a different device).
 *
 * The observer is therefore only ever triggered by `Y.applyUpdate`
 * calls that the Svelte component makes when sync pulls a fresher
 * yrs_state from etebase — there's no peer who can push Y.Doc ops over
 * a socket any more.
 *
 * Performance note: Excalidraw calls `onChange` frequently while
 * drawing. Don't write a full scene snapshot on each callback. That
 * makes Yjs retain a stream of large replaced arrays and quickly turns
 * a simple stroke into a huge persisted payload. We store elements/
 * files by id, store order separately, and throttle local writes.
 *
 * Image bytes are deliberately NOT in here. The files map holds a
 * `PersistedFileRef` pointing at the `assets` table (see
 * excalidraw-files.ts) — putting megabytes of base64 in the Y.Doc would
 * mean every sync ships the whole image again. Documents written before
 * that change stored files inline, so the read path still tolerates the
 * old shape and migrates it on sight.
 */

import * as Y from 'yjs';
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI
} from '@excalidraw/excalidraw/types';
import {
  ExcalidrawFileStore,
  isPersistedFileRef,
  type PersistedFileRef
} from './excalidraw-files';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';

const YJS_META_KEY = 'excalidraw:scene';
const YJS_ELEMENTS_KEY = 'excalidraw:elements';
const YJS_FILES_KEY = 'excalidraw:files';
const LOCAL_ORIGIN = 'excalidraw-local';
const MIGRATION_ORIGIN = 'excalidraw-migration';
const HISTORY_RESTORE_ORIGIN = 'excalidraw-history-restore';
const WRITE_THROTTLE_MS = 180;

// Scene-level Excalidraw settings that all collaborators should see.
// Viewport state (scrollX, scrollY, zoom) is intentionally NOT here:
// it's per-device, and broadcasting it makes every pan/zoom on one
// device snap the other devices' canvases — instantly unusable. The
// official Excalidraw collab and the y-excalidraw binding both make
// the same call (viewport stays local, syncs only when one user
// explicitly follows another).
type PersistedAppState = Pick<
  AppState,
  'viewBackgroundColor' | 'gridModeEnabled' | 'gridSize' | 'gridStep' | 'name'
>;

export interface ExcalidrawSceneSnapshot {
  elements: readonly ExcalidrawElement[];
  appState: Partial<PersistedAppState>;
  /** Asset references, not bytes. Resolve via `ExcalidrawFileStore`. */
  storedFiles: Record<string, StoredFile>;
}

export interface BindOptions {
  yDoc: Y.Doc;
  api: ExcalidrawImperativeAPI;
  /** Owning note for any image the user drops in — image bytes are stored
   *  as assets against it rather than inside the scene. */
  noteId: string;
}

export interface BindHandle {
  destroy(): void;
}

function metaMap(yDoc: Y.Doc): Y.Map<unknown> {
  return yDoc.getMap(YJS_META_KEY);
}

function elementsMap(yDoc: Y.Doc): Y.Map<ExcalidrawElement> {
  return yDoc.getMap(YJS_ELEMENTS_KEY);
}

type StoredFile = PersistedFileRef | BinaryFileData;

function filesMap(yDoc: Y.Doc): Y.Map<StoredFile> {
  return yDoc.getMap(YJS_FILES_KEY);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sanitizeAppState(appState: AppState): Partial<PersistedAppState> {
  return {
    viewBackgroundColor: appState.viewBackgroundColor,
    gridModeEnabled: appState.gridModeEnabled,
    gridSize: appState.gridSize,
    gridStep: appState.gridStep,
    name: appState.name
  };
}

function elementChanged(
  prev: ExcalidrawElement | undefined,
  next: ExcalidrawElement
): boolean {
  return (
    !prev ||
    prev.version !== next.version ||
    prev.versionNonce !== next.versionNonce ||
    prev.isDeleted !== next.isDeleted
  );
}

function shallowJsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function migrateLegacySnapshot(yDoc: Y.Doc): void {
  const meta = metaMap(yDoc);
  const legacyElements = meta.get('elements') as
    | readonly ExcalidrawElement[]
    | undefined;
  const legacyAppState = meta.get('appState') as
    | Partial<PersistedAppState>
    | undefined;
  const legacyFiles = meta.get('files') as BinaryFiles | undefined;

  if (!legacyElements && !legacyAppState && !legacyFiles) return;

  const eMap = elementsMap(yDoc);
  const fMap = filesMap(yDoc);
  yDoc.transact(() => {
    if (legacyElements) {
      for (const element of legacyElements) {
        eMap.set(element.id, cloneJson(element));
      }
      meta.set(
        'elementOrder',
        legacyElements.map((element) => element.id)
      );
    }
    if (legacyAppState) meta.set('appState', cloneJson(legacyAppState));
    if (legacyFiles) {
      for (const [id, file] of Object.entries(legacyFiles)) {
        fMap.set(id, cloneJson(file));
      }
    }
    meta.set('version', 2);
    meta.delete('elements');
    meta.delete('files');
  }, MIGRATION_ORIGIN);
}

export function readSceneFromYDoc(yDoc: Y.Doc): ExcalidrawSceneSnapshot {
  migrateLegacySnapshot(yDoc);

  const meta = metaMap(yDoc);
  const eMap = elementsMap(yDoc);
  const fMap = filesMap(yDoc);
  const order = (meta.get('elementOrder') as string[] | undefined) ?? [];
  const seen = new Set<string>();
  const elements: ExcalidrawElement[] = [];

  for (const id of order) {
    const element = eMap.get(id);
    if (!element) continue;
    seen.add(id);
    elements.push(cloneJson(element));
  }
  for (const [id, element] of eMap.entries()) {
    if (seen.has(id)) continue;
    elements.push(cloneJson(element));
  }

  const storedFiles: Record<string, StoredFile> = {};
  for (const [id, file] of fMap.entries()) {
    storedFiles[id] = cloneJson(file);
  }

  return {
    elements,
    appState: cloneJson(
      (meta.get('appState') as Partial<PersistedAppState> | undefined) ?? {}
    ),
    storedFiles
  };
}

function writeSceneToYDoc(
  yDoc: Y.Doc,
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  fileRefs: Record<string, PersistedFileRef>
): void {
  const meta = metaMap(yDoc);
  const eMap = elementsMap(yDoc);
  const fMap = filesMap(yDoc);
  const nextIds = new Set(elements.map((element) => element.id));
  const nextFileIds = new Set(Object.keys(fileRefs));
  const nextOrder = elements.map((element) => element.id);
  const nextAppState = sanitizeAppState(appState);

  // Compute exactly what's about to change BEFORE opening the transact.
  // Y.Map.set generates a CRDT op even when the value is structurally
  // identical, so unconditional writes (e.g. `meta.set('version', 2)`)
  // produce a sync frame on every flush — including ones triggered by
  // pan/zoom that don't touch any persisted field. Skip the transact
  // entirely when there's nothing to write.
  const versionNeedsWrite = meta.get('version') !== 2;
  const orderNeedsWrite = !shallowJsonEqual(
    meta.get('elementOrder'),
    nextOrder
  );
  const appStateNeedsWrite = !shallowJsonEqual(
    meta.get('appState'),
    nextAppState
  );

  const elementsToWrite: ExcalidrawElement[] = [];
  for (const element of elements) {
    if (elementChanged(eMap.get(element.id), element)) {
      elementsToWrite.push(element);
    }
  }
  const elementsToDelete: string[] = [];
  for (const id of Array.from(eMap.keys())) {
    if (!nextIds.has(id)) elementsToDelete.push(id);
  }

  const filesToWrite: Array<[string, PersistedFileRef]> = [];
  for (const [id, ref] of Object.entries(fileRefs)) {
    const current = fMap.get(id);
    // Rewrite when absent, when the version moved, or when the stored value
    // is still a legacy inline file — that last case is the migration.
    if (
      !current ||
      !isPersistedFileRef(current) ||
      current.assetId !== ref.assetId ||
      current.version !== ref.version
    ) {
      filesToWrite.push([id, ref]);
    }
  }
  const filesToDelete: string[] = [];
  for (const id of Array.from(fMap.keys())) {
    if (!nextFileIds.has(id)) filesToDelete.push(id);
  }

  if (
    !versionNeedsWrite &&
    !orderNeedsWrite &&
    !appStateNeedsWrite &&
    elementsToWrite.length === 0 &&
    elementsToDelete.length === 0 &&
    filesToWrite.length === 0 &&
    filesToDelete.length === 0
  ) {
    return;
  }

  yDoc.transact(() => {
    if (versionNeedsWrite) meta.set('version', 2);
    if (orderNeedsWrite) meta.set('elementOrder', cloneJson(nextOrder));
    if (appStateNeedsWrite) meta.set('appState', cloneJson(nextAppState));

    for (const element of elementsToWrite) {
      eMap.set(element.id, cloneJson(element));
    }
    for (const id of elementsToDelete) {
      eMap.delete(id);
    }

    for (const [id, ref] of filesToWrite) {
      fMap.set(id, cloneJson(ref));
    }
    for (const id of filesToDelete) {
      fMap.delete(id);
    }
  }, LOCAL_ORIGIN);
}

/**
 * One-shot write of whatever is on screen. Image references are carried over
 * from what the Y.Doc already holds — this path never uploads, so a file the
 * bound store hasn't persisted yet is left for the next bound flush.
 */
export function writeCurrentSceneToYDoc(
  yDoc: Y.Doc,
  api: ExcalidrawImperativeAPI
): void {
  const fMap = filesMap(yDoc);
  const refs: Record<string, PersistedFileRef> = {};
  for (const fileId of Object.keys(api.getFiles())) {
    const stored = fMap.get(fileId);
    if (isPersistedFileRef(stored)) refs[fileId] = stored;
  }
  writeSceneToYDoc(yDoc, api.getSceneElements(), api.getAppState(), refs);
}

export function replaceSceneInYDoc(
  yDoc: Y.Doc,
  snapshot: ExcalidrawSceneSnapshot
): void {
  const meta = metaMap(yDoc);
  const eMap = elementsMap(yDoc);
  const fMap = filesMap(yDoc);

  yDoc.transact(() => {
    for (const key of Array.from(meta.keys())) meta.delete(key);
    for (const key of Array.from(eMap.keys())) eMap.delete(key);
    for (const key of Array.from(fMap.keys())) fMap.delete(key);

    meta.set('version', 2);
    meta.set(
      'elementOrder',
      snapshot.elements.map((element) => element.id)
    );
    meta.set('appState', cloneJson(snapshot.appState));

    for (const element of snapshot.elements) {
      eMap.set(element.id, cloneJson(element));
    }
    for (const [id, file] of Object.entries(snapshot.storedFiles)) {
      fMap.set(id, cloneJson(file));
    }
  }, HISTORY_RESTORE_ORIGIN);
}

export function bindExcalidrawToLocalYDoc({
  yDoc,
  api,
  noteId
}: BindOptions): BindHandle {
  let applyingRemote = false;
  let destroyed = false;
  // An upload finishing is a reason to write again: the scene didn't change,
  // but we can now record where the bytes went.
  const fileStore = new ExcalidrawFileStore({
    noteId,
    onRefsChanged: () => {
      if (destroyed) return;
      pending = {
        elements: api.getSceneElements(),
        appState: api.getAppState(),
        files: api.getFiles()
      };
      scheduleFlush();
    }
  });
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFlush = 0;
  let pending: {
    elements: readonly ExcalidrawElement[];
    appState: AppState;
    files: BinaryFiles;
  } | null = null;

  // Last scene state we wrote-or-applied, used to short-circuit onChange
  // before it schedules a flush. Same pattern as y-excalidraw: keep the
  // "should I write?" decision orthogonal to what's in the Y.Doc, so a
  // spurious onChange after `api.updateScene` (which Excalidraw can fire
  // asynchronously, defeating the `applyingRemote` guard) doesn't trip
  // a meaningless write. Initialised from the current Y.Doc snapshot so
  // the very first onChange after mount doesn't re-write what we just
  // loaded as initialData.
  type ElState = { version: number; versionNonce: number; isDeleted: boolean };
  const lastKnownEls = new Map<string, ElState>();
  // `BinaryFileData.version` is optional in Excalidraw's types; treat it
  // as `number | undefined` so missing-version files round-trip cleanly
  // through the unchanged-check.
  const lastKnownFiles = new Map<string, number | undefined>();
  let lastKnownApp: Partial<PersistedAppState> = {};

  function captureEls(els: readonly ExcalidrawElement[]): void {
    lastKnownEls.clear();
    for (const el of els) {
      lastKnownEls.set(el.id, {
        version: el.version,
        versionNonce: el.versionNonce,
        isDeleted: Boolean(el.isDeleted)
      });
    }
  }

  function captureFiles(files: BinaryFiles): void {
    lastKnownFiles.clear();
    for (const [id, file] of Object.entries(files)) {
      lastKnownFiles.set(id, file.version);
    }
  }

  function elsUnchanged(els: readonly ExcalidrawElement[]): boolean {
    if (els.length !== lastKnownEls.size) return false;
    for (const el of els) {
      const k = lastKnownEls.get(el.id);
      if (
        !k ||
        k.version !== el.version ||
        k.versionNonce !== el.versionNonce ||
        k.isDeleted !== Boolean(el.isDeleted)
      ) {
        return false;
      }
    }
    return true;
  }

  function filesUnchanged(files: BinaryFiles): boolean {
    const entries = Object.entries(files);
    if (entries.length !== lastKnownFiles.size) return false;
    for (const [id, f] of entries) {
      if (lastKnownFiles.get(id) !== f.version) return false;
    }
    return true;
  }

  // Resolve stored references into real bytes and hand them to Excalidraw.
  // Async, so images pop in a beat after the scene — same as any other
  // asset-backed image in the app.
  function loadFiles(storedFiles: Record<string, StoredFile>): void {
    const refs: Record<string, PersistedFileRef> = {};
    for (const [fileId, value] of Object.entries(storedFiles)) {
      if (isPersistedFileRef(value)) refs[fileId] = value;
    }
    fileStore.adopt(refs);
    void fileStore.resolve(storedFiles).then((files) => {
      if (destroyed) return;
      const values = Object.values(files);
      if (values.length === 0) return;
      applyingRemote = true;
      try {
        api.addFiles(values);
      } finally {
        applyingRemote = false;
      }
    });
  }

  {
    const seed = readSceneFromYDoc(yDoc);
    captureEls(seed.elements);
    lastKnownApp = seed.appState;
    loadFiles(seed.storedFiles);
  }

  function clearFlushTimer(): void {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function flush(): void {
    clearFlushTimer();
    if (destroyed || !pending) return;
    const { elements, appState, files } = pending;
    pending = null;
    lastFlush = Date.now();
    // Upload anything new first; refsFor skips files still in flight, and
    // onRefsChanged schedules another flush once they land.
    fileStore.ensureUploaded(files);
    writeSceneToYDoc(
      yDoc,
      elements,
      appState,
      fileStore.refsFor(Object.keys(files))
    );
    captureEls(elements);
    // Only treat files as captured once they're all persisted, so a
    // half-uploaded scene still triggers a follow-up flush.
    if (fileStore.hasAllRefs(files)) captureFiles(files);
    lastKnownApp = sanitizeAppState(appState);
  }

  function scheduleFlush(): void {
    const elapsed = Date.now() - lastFlush;
    if (elapsed >= WRITE_THROTTLE_MS) {
      flush();
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(flush, WRITE_THROTTLE_MS - elapsed);
    }
  }

  const unlistenEditor = api.onChange((elements, appState, files) => {
    if (destroyed || applyingRemote || appState.viewModeEnabled) return;
    const sanitized = sanitizeAppState(appState);
    if (
      elsUnchanged(elements) &&
      filesUnchanged(files) &&
      shallowJsonEqual(lastKnownApp, sanitized)
    ) {
      return;
    }
    pending = { elements, appState, files };
    scheduleFlush();
  });

  const unlistenPointerUp = api.onPointerUp(() => {
    flush();
  });

  const applyScene = () => {
    const snapshot = readSceneFromYDoc(yDoc);
    loadFiles(snapshot.storedFiles);
    applyingRemote = true;
    try {
      api.updateScene({
        elements: snapshot.elements,
        appState: snapshot.appState as Pick<AppState, keyof PersistedAppState>,
        captureUpdate: CaptureUpdateAction.NEVER
      });
    } finally {
      applyingRemote = false;
    }
    captureEls(snapshot.elements);
    lastKnownApp = snapshot.appState;
  };

  // Fires when something other than our own write touches the Y.Doc.
  // The only such "something" today is the FreeformNoteEditor calling
  // `Y.applyUpdate(yDoc, fresh.yrs_state)` after sync pulls a newer
  // copy from etebase. Live collab no longer flows through here.
  const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    if (
      events.every(
        (event) =>
          event.transaction.origin === LOCAL_ORIGIN ||
          event.transaction.origin === MIGRATION_ORIGIN
      )
    ) {
      return;
    }
    applyScene();
  };

  metaMap(yDoc).observeDeep(observer);
  elementsMap(yDoc).observeDeep(observer);
  filesMap(yDoc).observeDeep(observer);

  return {
    destroy() {
      if (destroyed) return;
      flush();
      destroyed = true;
      clearFlushTimer();
      unlistenPointerUp();
      unlistenEditor();
      fileStore.destroy();
      metaMap(yDoc).unobserveDeep(observer);
      elementsMap(yDoc).unobserveDeep(observer);
      filesMap(yDoc).unobserveDeep(observer);
    }
  };
}
