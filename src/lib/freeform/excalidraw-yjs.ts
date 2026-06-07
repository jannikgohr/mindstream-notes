/**
 * Small Yjs scene adapter for Excalidraw-backed freeform notes.
 *
 * Excalidraw exposes scene snapshots (`elements`, selected app state,
 * `files`) rather than a public CRDT record store. We keep one Y.Map with
 * those three JSON-safe fields. Local editor changes write a fresh
 * snapshot into Yjs; remote Yjs updates hydrate the open editor through
 * `updateScene`.
 */

import * as Y from 'yjs';
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI
} from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';

const YJS_SCENE_KEY = 'excalidraw:scene';
const LOCAL_ORIGIN = 'excalidraw-local';

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

function sceneMap(yDoc: Y.Doc): Y.Map<unknown> {
  return yDoc.getMap(YJS_SCENE_KEY);
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

export function readSceneFromYDoc(yDoc: Y.Doc): ExcalidrawSceneSnapshot {
  const map = sceneMap(yDoc);
  return {
    elements: cloneJson(
      (map.get('elements') as readonly ExcalidrawElement[] | undefined) ?? []
    ),
    appState: cloneJson(
      (map.get('appState') as Partial<PersistedAppState> | undefined) ?? {}
    ),
    files: cloneJson((map.get('files') as BinaryFiles | undefined) ?? {})
  };
}

export function writeSceneToYDoc(
  yDoc: Y.Doc,
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles
): void {
  const map = sceneMap(yDoc);
  yDoc.transact(() => {
    map.set('version', 1);
    map.set('elements', cloneJson(elements));
    map.set('appState', cloneJson(sanitizeAppState(appState)));
    map.set('files', cloneJson(files));
  }, LOCAL_ORIGIN);
}

export function bindExcalidrawToYDoc({ yDoc, api }: BindOptions): BindHandle {
  let applyingRemote = false;

  const unlistenEditor = api.onChange((elements, appState, files) => {
    if (applyingRemote || appState.viewModeEnabled) return;
    writeSceneToYDoc(yDoc, elements, appState, files);
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
    if (events.every((event) => event.transaction.origin === LOCAL_ORIGIN)) {
      return;
    }
    applyScene();
  };

  sceneMap(yDoc).observeDeep(observer);

  let destroyed = false;
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unlistenEditor();
      sceneMap(yDoc).unobserveDeep(observer);
    }
  };
}
