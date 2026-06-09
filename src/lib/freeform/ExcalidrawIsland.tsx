/**
 * React island that hosts Excalidraw for freeform notes.
 *
 * The Svelte shell owns note loading, Y.Doc persistence, save debounce,
 * and collab sockets. This island owns the Excalidraw component plus the
 * scene snapshot bridge into that Y.Doc.
 */

import {
  Excalidraw,
  CaptureUpdateAction
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import type {
  ExcalidrawInitialDataState,
  ExcalidrawImperativeAPI
} from '@excalidraw/excalidraw/types';
import type { Theme } from '@excalidraw/excalidraw/element/types';
import {
  bindExcalidrawToLocalYDoc,
  readSceneFromYDoc,
  type BindHandle
} from './excalidraw-yjs';

export type PenModeSetting = 'auto' | 'always' | 'off';

export interface ExcalidrawIslandProps {
  yDoc: Y.Doc;
  readOnly: boolean;
  noteId: string;
  colorScheme: 'light' | 'dark' | 'system';
  penMode: PenModeSetting;
  reduceMotion: boolean;
  /** Surfaces the Excalidraw API up to the Svelte parent, which feeds
   *  it to the excalidraw-room client. Receives null on unmount. */
  onApiReady?: (api: ExcalidrawImperativeAPI | null) => void;
}

function resolveTheme(colorScheme: ExcalidrawIslandProps['colorScheme']): Theme {
  if (colorScheme === 'light' || colorScheme === 'dark') return colorScheme;
  if (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
  ) {
    return 'dark';
  }
  return 'light';
}

function useResolvedTheme(
  colorScheme: ExcalidrawIslandProps['colorScheme']
): Theme {
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(colorScheme));
  useEffect(() => {
    setTheme(resolveTheme(colorScheme));
    if (colorScheme !== 'system' || typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setTheme(resolveTheme('system'));
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [colorScheme]);
  return theme;
}

function initialDataFor(
  yDoc: Y.Doc,
  theme: Theme,
  readOnly: boolean,
  penMode: PenModeSetting
): ExcalidrawInitialDataState {
  const snapshot = readSceneFromYDoc(yDoc);
  return {
    type: 'excalidraw',
    version: 2,
    source: 'mindstream-notes',
    elements: snapshot.elements,
    appState: {
      ...snapshot.appState,
      theme,
      viewModeEnabled: readOnly,
      penMode: penMode === 'always' ? true : false
    },
    files: snapshot.files,
    scrollToContent: snapshot.elements.length > 0
  };
}

export default function ExcalidrawIsland({
  yDoc,
  readOnly,
  noteId: _noteId,
  colorScheme,
  penMode,
  reduceMotion,
  onApiReady
}: ExcalidrawIslandProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const bindRef = useRef<BindHandle | null>(null);
  const onApiReadyRef = useRef(onApiReady);
  onApiReadyRef.current = onApiReady;
  const [apiReady, setApiReady] = useState(false);
  const theme = useResolvedTheme(colorScheme);

  const initialData = useMemo(
    () => initialDataFor(yDoc, theme, readOnly, penMode),
    [yDoc]
  );

  useEffect(() => {
    return () => {
      bindRef.current?.destroy();
      bindRef.current = null;
      onApiReadyRef.current?.(null);
      apiRef.current = null;
    };
  }, []);

  const handleApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      apiRef.current = api;
      bindRef.current?.destroy();
      bindRef.current = bindExcalidrawToLocalYDoc({ yDoc, api });
      setApiReady(true);
      onApiReadyRef.current?.(api);
    },
    [yDoc]
  );

  useEffect(() => {
    const api = apiRef.current;
    if (!apiReady || !api) return;
    api.updateScene({
      appState: {
        theme,
        viewModeEnabled: readOnly
      },
      captureUpdate: CaptureUpdateAction.NEVER
    });
  }, [apiReady, theme, readOnly]);

  useEffect(() => {
    const api = apiRef.current;
    if (!apiReady || !api) return;
    api.updateScene({
      appState: {
        penMode: penMode === 'always'
      },
      captureUpdate: CaptureUpdateAction.NEVER
    });
  }, [apiReady, penMode]);

  useEffect(() => {
    if (penMode !== 'auto') return;
    const root = rootRef.current;
    const api = apiRef.current;
    if (!apiReady || !root || !api) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'pen') return;
      if (api.getAppState().penMode) return;
      api.updateScene({
        appState: { penMode: true },
        captureUpdate: CaptureUpdateAction.NEVER
      });
    };
    root.addEventListener('pointerdown', onPointerDown, true);
    return () => root.removeEventListener('pointerdown', onPointerDown, true);
  }, [apiReady, penMode]);

  return (
    <div
      ref={rootRef}
      className={`freeform-excalidraw-host${reduceMotion ? ' reduce-motion' : ''}`}
      style={{ position: 'absolute', inset: 0 }}
    >
      <Excalidraw
        initialData={initialData}
        excalidrawAPI={handleApi}
        viewModeEnabled={readOnly}
        theme={theme}
        detectScroll={false}
        handleKeyboardGlobally={false}
        onPaste={(data) => Boolean(data.files && Object.keys(data.files).length)}
        UIOptions={{
          canvasActions: {
            export: false,
            loadScene: false,
            saveToActiveFile: false,
            saveAsImage: true,
            toggleTheme: false
          },
          tools: {
            image: false
          }
        }}
      />
    </div>
  );
}
