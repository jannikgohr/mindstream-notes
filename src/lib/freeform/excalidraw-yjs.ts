/**
 * Yjs scene adapter for Excalidraw-backed freeform notes.
 *
 * Important performance note: Excalidraw calls `onChange` frequently while
 * drawing. Do not write a full scene snapshot on each callback. That makes
 * Yjs retain a stream of large replaced arrays and quickly turns a simple
 * stroke into a huge persisted/synced payload. We store elements/files by id,
 * store order separately, and throttle local writes.
 */

import * as Y from 'yjs';
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI
} from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';

const YJS_META_KEY = 'excalidraw:scene';
const YJS_ELEMENTS_KEY = 'excalidraw:elements';
const YJS_FILES_KEY = 'excalidraw:files';
const LOCAL_ORIGIN = 'excalidraw-local';
const MIGRATION_ORIGIN = 'excalidraw-migration';
const WRITE_THROTTLE_MS = 180;

type PersistedAppState = Pick<
  AppState,
  | 'viewBackgroundColor'
  | 'gridModeEnabled'
  | 'gridSize'
  | 'gridStep'
  | 'name'
  | 'scrollX'
  | 'scrollY'
  | 'zoom'
>;

export interface ExcalidrawSceneSnapshot {
  elements: readonly ExcalidrawElement[];
  appState: Partial<PersistedAppState>;
  files: BinaryFiles;
}

export interface BindOptions {
  yDoc: Y.Doc;
  api: ExcalidrawImperativeAPI;
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

function filesMap(yDoc: Y.Doc): Y.Map<BinaryFileData> {
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
    name: appState.name,
    scrollX: appState.scrollX,
    scrollY: appState.scrollY,
    zoom: appState.zoom
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

  const files: BinaryFiles = {};
  for (const [id, file] of fMap.entries()) {
    files[id] = cloneJson(file);
  }

  return {
    elements,
    appState: cloneJson(
      (meta.get('appState') as Partial<PersistedAppState> | undefined) ?? {}
    ),
    files
  };
}

function writeSceneToYDoc(
  yDoc: Y.Doc,
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles
): void {
  const meta = metaMap(yDoc);
  const eMap = elementsMap(yDoc);
  const fMap = filesMap(yDoc);
  const nextIds = new Set(elements.map((element) => element.id));
  const nextFileIds = new Set(Object.keys(files));
  const nextOrder = elements.map((element) => element.id);
  const nextAppState = sanitizeAppState(appState);

  yDoc.transact(() => {
    meta.set('version', 2);
    if (!shallowJsonEqual(meta.get('elementOrder'), nextOrder)) {
      meta.set('elementOrder', cloneJson(nextOrder));
    }
    if (!shallowJsonEqual(meta.get('appState'), nextAppState)) {
      meta.set('appState', cloneJson(nextAppState));
    }

    for (const element of elements) {
      if (elementChanged(eMap.get(element.id), element)) {
        eMap.set(element.id, cloneJson(element));
      }
    }
    for (const id of Array.from(eMap.keys())) {
      if (!nextIds.has(id)) eMap.delete(id);
    }

    for (const [id, file] of Object.entries(files)) {
      const current = fMap.get(id);
      if (!current || current.version !== file.version) {
        fMap.set(id, cloneJson(file));
      }
    }
    for (const id of Array.from(fMap.keys())) {
      if (!nextFileIds.has(id)) fMap.delete(id);
    }
  }, LOCAL_ORIGIN);
}

export function bindExcalidrawToYDoc({ yDoc, api }: BindOptions): BindHandle {
  let applyingRemote = false;
  let destroyed = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFlush = 0;
  let pending: {
    elements: readonly ExcalidrawElement[];
    appState: AppState;
    files: BinaryFiles;
  } | null = null;

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
    writeSceneToYDoc(yDoc, elements, appState, files);
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
    pending = { elements, appState, files };
    scheduleFlush();
  });

  const unlistenPointerUp = api.onPointerUp(() => {
    flush();
  });

  const applyScene = () => {
    const snapshot = readSceneFromYDoc(yDoc);
    applyingRemote = true;
    try {
      api.addFiles(Object.values(snapshot.files));
      api.updateScene({
        elements: snapshot.elements,
        appState: snapshot.appState as Pick<AppState, keyof PersistedAppState>,
        captureUpdate: CaptureUpdateAction.NEVER
      });
    } finally {
      applyingRemote = false;
    }
  };

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
      metaMap(yDoc).unobserveDeep(observer);
      elementsMap(yDoc).unobserveDeep(observer);
      filesMap(yDoc).unobserveDeep(observer);
    }
  };
}
