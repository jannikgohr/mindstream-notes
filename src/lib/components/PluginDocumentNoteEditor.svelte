<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { EditorView } from '@codemirror/view';
  import { AlertTriangle, Loader2, RefreshCw } from '@lucide/svelte';
  import { loadNote } from '$lib/api';
  import {
    pluginsArtifactsStatus,
    pluginsDownloadArtifact,
    pluginsNativeServiceStatus,
    pluginsNativeToolStatus,
    pluginsReadArtifact,
    pluginsRunScript
  } from '$lib/api/plugins';
  import { isMobile } from '$lib/platform';
  import { base64ToBytes } from '$lib/editor/base64';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    PreviewServiceController,
    previewProxyUrl,
    PREVIEW_PROXY_READY
  } from '$lib/plugins/preview-service';
  import PluginPdfPreview from './PluginPdfPreview.svelte';
  import { setNoteBody } from '$lib/stores/tree.svelte';
  import { pluginById, pluginNoteKind } from '$lib/plugins/registry.svelte';
  import { readPluginFile } from '$lib/plugins/plugin-files';
  import { getSettingValue } from '$lib/settings/store.svelte';
  import SourceEditor from '$lib/editor/source/SourceEditor.svelte';
  import EditorModeToggle from '$lib/editor/source/EditorModeToggle.svelte';
  import {
    coerceViewMode,
    nextViewMode,
    type EditorViewMode
  } from '$lib/editor/source/view-mode';
  import { splitAvailable } from '$lib/editor/source/split-available.svelte';
  import { SOURCE_ACTIONS } from '$lib/editor/source/source-actions';
  import {
    APP_REDO_COMMAND,
    APP_UNDO_COMMAND,
    registerEditor,
    unregisterEditor,
    type EditorListener
  } from '$lib/hotkeys/bus.svelte';
  import PluginSourceToolbar from './PluginSourceToolbar.svelte';

  interface Props {
    noteId: string;
    noteKind?: string | null;
  }

  type DiagnosticSeverity = 'info' | 'warning' | 'error';

  interface Diagnostic {
    message: string;
    severity?: DiagnosticSeverity;
  }

  interface WebviewArtifactPayload {
    id: string;
    kind: string;
    fileName: string;
    bytes: Uint8Array;
  }

  let { noteId, noteKind }: Props = $props();

  let source = $state('');
  let loading = $state(true);
  let rendering = $state(false);
  let loadError = $state<string | null>(null);
  let renderError = $state<string | null>(null);
  let previewText = $state('');
  let previewMime = $state('text/plain');
  // Decoded binary preview (e.g. a PDF from typst), rendered by PluginPdfPreview
  // instead of the srcdoc iframe. Null for text/svg/html previews.
  let previewData = $state<Uint8Array | null>(null);
  let diagnostics = $state<Diagnostic[]>([]);
  let dirty = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let loadToken = 0;
  let renderToken = 0;
  let destroyed = false;
  let viewMode = $state<EditorViewMode>('split');
  let viewModeSeed = '';
  let editorRegionEl: HTMLDivElement | null = $state(null);
  let previewIframe: HTMLIFrameElement | null = $state(null);
  let sourceEditor = $state<{
    setText: (text: string) => void;
    flush: () => void;
    focus: () => void;
    getView: () => EditorView | null;
  } | null>(null);
  let editorListener: EditorListener | null = null;
  let webviewLoadToken = 0;
  let webviewInitSent = false;
  let webviewInitialized = false;
  let webviewEntry = '';
  let webviewArtifacts: WebviewArtifactPayload[] = [];

  // Native-tool render gating: when a note kind declares `requiresNativeTool`
  // the host checks the binary is available before ever rendering. If it isn't
  // (not installed, or a mobile platform) the editor drops to source-only.
  type ToolState = 'unknown' | 'checking' | 'available' | 'unavailable';
  let toolState = $state<ToolState>('unknown');
  let toolBinaryName = $state('');
  let toolCheckToken = 0;
  const mobile = isMobile();

  // Live preview service (e.g. tinymist): when its binary is available the
  // editor loads the service's own frontend in an iframe with click-to-source,
  // instead of the `export` (PDF) renderer.
  let serviceState = $state<ToolState>('unknown');
  let serviceDataUrl = $state<string | null>(null);
  let serviceProxyUrl = $state<string | null>(null);
  let serviceController: PreviewServiceController | null = null;
  let serviceCheckToken = 0;
  // The iframe is served through our theme-injecting reverse proxy by default;
  // if its readiness beacon doesn't arrive (e.g. a webview rejects our CSP), we
  // fall back to loading the server directly so the preview still works.
  let proxyState = $state<'trying' | 'ok' | 'fallback'>('trying');
  const PREVIEW_BG_FALLBACK = 'oklch(0.1735 0.002 286.18)';
  let previewBg = $state(PREVIEW_BG_FALLBACK);
  let previewFg = $state('rgb(255,255,255)');
  let previewGutter = $state('12px');
  let previewScrollbar = $state('rgba(255,255,255,0.3)');
  let proxyFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  const contributionRef = $derived(pluginNoteKind(noteKind));
  const storedNoteKind = $derived(contributionRef?.noteKind ?? noteKind ?? '');
  const sourceLanguage = $derived(
    contributionRef?.contribution.sourceLanguage ?? 'text'
  );
  const debounceMs = $derived(
    contributionRef?.contribution.render.debounceMs ?? 250
  );
  const autoPairEnabled = $derived(
    (getSettingValue('editor.autoPair') as boolean | undefined) ?? true
  );
  const sourceTabSize = $derived.by(() => {
    const v = Number(getSettingValue('editor.tabSize'));
    return Number.isFinite(v) && v > 0 ? Math.min(8, v) : 2;
  });
  const iframeSrcdoc = $derived(buildPreviewDocument(previewMime, previewText));
  const webviewPreview = $derived(contributionRef?.contribution.render.webview);
  const previewSrcdoc = $derived(
    webviewPreview ? buildWebviewPreviewDocument() : iframeSrcdoc
  );
  const requiredToolId = $derived(
    contributionRef?.contribution.render.requiresNativeTool
  );
  const previewServiceId = $derived(
    contributionRef?.contribution.render.previewService
  );
  // A live preview service (e.g. tinymist) takes over when its binary is present.
  const serviceUsable = $derived(
    !!previewServiceId && serviceState === 'available'
  );
  const sessionKey = $derived(
    contributionRef ? `${contributionRef.pluginId}:${noteId}` : ''
  );
  // What the live-preview iframe loads: the theme-injecting proxy by default,
  // the server directly once we've fallen back.
  const serviceIframeSrc = $derived.by(() => {
    if (!serviceDataUrl) return null;
    return proxyState === 'fallback'
      ? serviceDataUrl
      : serviceProxyUrl
        ? previewProxyUrl(
            serviceProxyUrl,
            previewBg,
            previewFg,
            previewGutter,
            previewScrollbar
          )
        : null;
  });
  // Preview is blocked (source-only) only when neither the live service nor the
  // declared PDF tool is available.
  const previewBlocked = $derived(
    !serviceUsable && !!requiredToolId && toolState !== 'available'
  );
  const showSource = $derived(previewBlocked || viewMode !== 'wysiwyg');
  const showPreview = $derived(!previewBlocked && viewMode !== 'source');
  const splitMode = $derived(showSource && showPreview);

  $effect(() => {
    const ref = contributionRef;
    if (!ref) return;
    const key = `${noteId}:${ref.pluginId}`;
    if (viewModeSeed === key) return;
    viewMode = coerceViewMode(
      getSettingValue(`plugins.${ref.pluginId}.default-view-mode`) ?? 'split',
      splitAvailable()
    );
    viewModeSeed = key;
  });

  // Check the declared native tool's availability whenever the owning plugin /
  // required tool changes. Result gates the preview (see `previewBlocked`).
  $effect(() => {
    const ref = contributionRef;
    const toolId = requiredToolId;
    if (!ref || !toolId) {
      toolState = 'unknown';
      return;
    }
    void checkTool(ref.pluginId, toolId);
  });

  async function checkTool(pluginId: string, toolId: string) {
    const token = ++toolCheckToken;
    toolState = 'checking';
    try {
      const status = await pluginsNativeToolStatus(pluginId, toolId);
      if (destroyed || token !== toolCheckToken) return;
      toolBinaryName = status.binaryName;
      toolState = status.available ? 'available' : 'unavailable';
      if (status.available) scheduleRender(0);
    } catch {
      if (destroyed || token !== toolCheckToken) return;
      toolState = 'unavailable';
    }
  }

  function recheckTool() {
    const ref = contributionRef;
    if (ref && requiredToolId) void checkTool(ref.pluginId, requiredToolId);
  }

  // Check whether the declared live-preview service's binary is available.
  $effect(() => {
    const ref = contributionRef;
    const serviceId = previewServiceId;
    if (!ref || !serviceId || mobile) {
      serviceState = mobile && serviceId ? 'unavailable' : 'unknown';
      return;
    }
    const token = ++serviceCheckToken;
    serviceState = 'checking';
    void (async () => {
      try {
        const status = await pluginsNativeServiceStatus(
          ref.pluginId,
          serviceId
        );
        if (destroyed || token !== serviceCheckToken) return;
        serviceState = status.available ? 'available' : 'unavailable';
      } catch {
        if (destroyed || token !== serviceCheckToken) return;
        serviceState = 'unavailable';
      }
    })();
  });

  // Start / stop the live preview server for this note. Runs once the service
  // is confirmed available and the note body has loaded; torn down on note
  // change or teardown. `source` is read untracked so edits don't restart it.
  $effect(() => {
    const ref = contributionRef;
    const serviceId = previewServiceId;
    if (!ref || !serviceId || serviceState !== 'available' || loading) return;
    const controller = new PreviewServiceController({
      pluginId: ref.pluginId,
      serviceId,
      sessionKey: `${ref.pluginId}:${noteId}`,
      jumpEvent: previewServiceJumpEvent(ref.pluginId, serviceId),
      onJump: (jump) => jumpToSource(jump.line, jump.column),
      onReady: (url, proxyUrl) => {
        if (destroyed) return;
        serviceDataUrl = url;
        serviceProxyUrl = proxyUrl;
        startProxyAttempt();
      },
      onError: (message) => {
        if (!destroyed) renderError = message;
      }
    });
    serviceController = controller;
    void controller.start(untrack(() => source));
    return () => {
      controller.dispose();
      if (serviceController === controller) serviceController = null;
      serviceDataUrl = null;
      serviceProxyUrl = null;
      if (proxyFallbackTimer) clearTimeout(proxyFallbackTimer);
    };
  });

  /** Read app theme values to mirror inside the proxied preview iframe. */
  function readPreviewTheme(): {
    bg: string;
    fg: string;
    gutter: string;
    scrollbar: string;
  } {
    try {
      const probe = document.createElement('div');
      probe.className = 'p-3 text-foreground';
      probe.style.cssText =
        'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px';
      document.body.appendChild(probe);
      const style = getComputedStyle(probe);
      const rootStyle = getComputedStyle(document.documentElement);
      const bodyStyle = getComputedStyle(document.body);
      const bg =
        rootStyle.getPropertyValue('--background').trim() ||
        bodyStyle.getPropertyValue('--background').trim() ||
        PREVIEW_BG_FALLBACK;
      const gutter = style.paddingTop || '12px';
      const fg = style.color || 'rgb(255,255,255)';
      probe.remove();
      return {
        bg,
        fg,
        gutter,
        scrollbar: colorWithAlpha(fg, 0.3)
      };
    } catch {
      return {
        bg: PREVIEW_BG_FALLBACK,
        fg: 'rgb(255,255,255)',
        gutter: '12px',
        scrollbar: 'rgba(255,255,255,0.3)'
      };
    }
  }

  function colorWithAlpha(color: string, alpha: number): string {
    if (color.startsWith('rgb(')) {
      return color.replace(/^rgb\((.*)\)$/i, `rgba($1,${alpha})`);
    }
    if (color.startsWith('rgba(')) {
      return color.replace(/^rgba\((.*),\s*[\d.]+\)$/i, `rgba($1,${alpha})`);
    }
    return color;
  }

  // Optimistically load through the theme-injecting proxy; if its readiness
  // beacon (an injected inline script) hasn't fired shortly, a webview has
  // rejected our CSP — fall back to loading the server directly.
  function refreshPreviewTheme() {
    const theme = readPreviewTheme();
    previewBg = theme.bg;
    previewFg = theme.fg;
    previewGutter = theme.gutter;
    previewScrollbar = theme.scrollbar;
  }

  function startProxyAttempt() {
    proxyState = 'trying';
    refreshPreviewTheme();
    if (proxyFallbackTimer) clearTimeout(proxyFallbackTimer);
    proxyFallbackTimer = setTimeout(() => {
      if (!destroyed && proxyState === 'trying') proxyState = 'fallback';
    }, 4000);
  }

  $effect(() => {
    if (!serviceProxyUrl || proxyState === 'fallback') return;
    refreshPreviewTheme();

    const refresh = () => refreshPreviewTheme();
    const observer = new MutationObserver(refresh);
    const options: MutationObserverInit = {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme']
    };
    observer.observe(document.documentElement, options);
    if (document.body) observer.observe(document.body, options);

    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener('change', refresh);

    return () => {
      observer.disconnect();
      media?.removeEventListener('change', refresh);
    };
  });

  $effect(() => {
    function onProxyMessage(event: MessageEvent) {
      const data = event.data as Record<string, unknown> | null;
      if (data && data.type === PREVIEW_PROXY_READY) {
        if (proxyFallbackTimer) clearTimeout(proxyFallbackTimer);
        if (!destroyed) proxyState = 'ok';
      }
    }
    window.addEventListener('message', onProxyMessage);
    return () => window.removeEventListener('message', onProxyMessage);
  });

  /** Resolve the manifest-declared control-plane jump event name for a service. */
  function previewServiceJumpEvent(
    pluginId: string,
    serviceId: string
  ): string {
    const service = pluginById(
      pluginId
    )?.manifest.contributes.nativeServices?.find((s) => s.id === serviceId);
    return service?.protocol?.jumpEvent ?? 'editorScrollTo';
  }

  /** Move the source-editor caret to a 0-indexed (line, column). */
  function jumpToSource(line: number, column: number) {
    const view = sourceEditor?.getView();
    if (!view) return;
    const lineNo = Math.min(view.state.doc.lines, Math.max(1, line + 1));
    const lineObj = view.state.doc.line(lineNo);
    const pos = Math.min(lineObj.to, lineObj.from + Math.max(0, column));
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  }

  $effect(() => {
    const id = noteId;
    const kind = noteKind;
    const token = ++loadToken;
    loading = true;
    loadError = null;
    renderError = null;
    diagnostics = [];
    void (async () => {
      try {
        const note = await loadNote(id);
        if (destroyed || token !== loadToken) return;
        source = note.body ?? '';
        dirty = false;
        if (kind && note.note_kind !== kind) {
          loadError = `Expected ${kind}, found ${note.note_kind}.`;
          return;
        }
        scheduleRender(0);
      } catch (err) {
        if (destroyed || token !== loadToken) return;
        loadError = toErrorMessage(err);
      } finally {
        if (!destroyed && token === loadToken) loading = false;
      }
    })();
  });

  $effect(() => {
    const region = editorRegionEl;
    if (!region) return;
    const listener: EditorListener = {
      kind: 'plugin',
      host: region,
      noteId,
      onCommand: (id) => {
        if (id !== APP_UNDO_COMMAND && id !== APP_REDO_COMMAND) return false;
        const view = sourceEditor?.getView() ?? null;
        const action = view ? SOURCE_ACTIONS[id] : undefined;
        if (!view || !action) return false;
        action(view);
        return true;
      }
    };
    editorListener = listener;
    const promote = () => untrack(() => registerEditor(listener));
    untrack(() => registerEditor(listener));
    region.addEventListener('focusin', promote);
    return () => {
      region.removeEventListener('focusin', promote);
      untrack(() => unregisterEditor(listener));
      if (editorListener === listener) editorListener = null;
    };
  });

  $effect(() => {
    const ref = contributionRef;
    const webview = ref?.contribution.render.webview;
    const token = ++webviewLoadToken;
    webviewInitSent = false;
    webviewInitialized = false;
    webviewEntry = '';
    webviewArtifacts = [];
    if (!ref || !webview) return;
    void (async () => {
      try {
        const entry = await readPluginFile(ref.pluginId, webview.entry);
        if (destroyed || token !== webviewLoadToken) return;
        if (entry === null) {
          throw new Error(
            `Plugin preview entry '${webview.entry}' was not found.`
          );
        }
        const artifacts = await loadWebviewArtifacts(
          ref.pluginId,
          webview.artifacts ?? []
        );
        if (destroyed || token !== webviewLoadToken) return;
        webviewEntry = entry;
        webviewArtifacts = artifacts;
        sendWebviewInit();
        scheduleRender(0);
      } catch (err) {
        if (destroyed || token !== webviewLoadToken) return;
        renderError = err instanceof Error ? err.message : String(err);
      }
    })();
  });

  $effect(() => {
    if (!webviewPreview) return;
    const iframe = previewIframe;
    if (!iframe) return;
    webviewInitSent = false;
    webviewInitialized = false;
    const onLoad = () => {
      sendWebviewInit();
      scheduleRender(0);
    };
    iframe.addEventListener('load', onLoad);
    return () => iframe.removeEventListener('load', onLoad);
  });

  function onSourceInput(value: string) {
    source = value;
    scheduleSave();
    // A live preview service recompiles from the pushed body; the `export`
    // renderer only runs when no service is driving the preview.
    if (serviceController) serviceController.updateBody(value);
    else scheduleRender(debounceMs);
  }

  function cycleViewMode() {
    viewMode = nextViewMode(viewMode, splitAvailable());
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flushSave();
    }, 400);
  }

  async function flushSave() {
    if (!dirty) return;
    dirty = false;
    try {
      await setNoteBody(noteId, source);
    } catch (err) {
      dirty = true;
      console.warn('[plugin-note] save failed', err);
    }
  }

  function scheduleRender(delay: number) {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderTimer = null;
      void renderNow();
    }, delay);
  }

  async function renderNow() {
    const ref = contributionRef;
    if (!ref) {
      renderError = 'No enabled plugin owns this note kind.';
      previewText = '';
      diagnostics = [];
      return;
    }
    // The live preview service owns the preview when available — skip the
    // `export` (PDF) render entirely.
    if (serviceUsable) {
      rendering = false;
      return;
    }
    // A note kind that needs a native tool never renders until it's confirmed
    // present — the editor stays source-only instead.
    if (requiredToolId && toolState !== 'available') {
      rendering = false;
      return;
    }
    if (ref.contribution.render.webview) {
      renderWebviewNow(ref);
      return;
    }
    const token = ++renderToken;
    rendering = true;
    renderError = null;
    try {
      const raw = await pluginsRunScript(
        ref.pluginId,
        ref.contribution.render.export,
        {
          noteId,
          noteKind: ref.noteKind,
          body: source,
          sourceLanguage
        }
      );
      if (destroyed || token !== renderToken) return;
      // The renderer can report it can't run (e.g. the tool vanished mid-session);
      // treat that as unavailable so the editor falls back to source-only.
      if (
        raw &&
        typeof raw === 'object' &&
        (raw as Record<string, unknown>).sourceOnly
      ) {
        toolState = 'unavailable';
        previewText = '';
        previewData = null;
        diagnostics = [];
        return;
      }
      const parsed = parseRenderResult(
        raw,
        ref.contribution.render.previewMime ?? 'text/plain'
      );
      previewMime = parsed.mime;
      if (parsed.mime === 'application/pdf') {
        previewData = parsed.dataBase64
          ? base64ToBytes(parsed.dataBase64)
          : null;
        previewText = '';
      } else {
        previewData = null;
        previewText = parsed.text;
      }
      diagnostics = parsed.diagnostics;
    } catch (err) {
      if (destroyed || token !== renderToken) return;
      renderError = toErrorMessage(err);
      diagnostics = [];
    } finally {
      if (!destroyed && token === renderToken) rendering = false;
    }
  }

  /**
   * Extract a human message from anything thrown. Tauri command rejections are
   * structured objects (`{ code, message }`), not `Error`s — `String(err)` on
   * those yields the useless "[object Object]", so pull `.message` first.
   */
  function toErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const rec = err as Record<string, unknown>;
      if (typeof rec.message === 'string') return rec.message;
      try {
        return JSON.stringify(err);
      } catch {
        return String(err);
      }
    }
    return String(err);
  }

  async function loadWebviewArtifacts(
    pluginId: string,
    artifactIds: string[]
  ): Promise<WebviewArtifactPayload[]> {
    if (artifactIds.length === 0) return [];
    const statuses = await pluginsArtifactsStatus(pluginId);
    const byId = new Map(statuses.map((status) => [status.artifactId, status]));
    const out: WebviewArtifactPayload[] = [];
    for (const artifactId of artifactIds) {
      let status = byId.get(artifactId);
      if (!status)
        throw new Error(`Plugin artifact '${artifactId}' is not declared.`);
      if (!status.installed) {
        status = await pluginsDownloadArtifact(pluginId, artifactId);
      }
      const bytes = await pluginsReadArtifact(pluginId, artifactId);
      out.push({
        id: artifactId,
        kind: status.kind,
        fileName: status.fileName,
        bytes
      });
    }
    return out;
  }

  function sendWebviewInit() {
    if (!webviewPreview || !previewIframe?.contentWindow || !webviewEntry) {
      return;
    }
    if (webviewInitSent || webviewInitialized) return;
    webviewInitSent = true;
    previewIframe.contentWindow.postMessage(
      {
        type: 'mindstream-plugin-preview-init',
        entry: webviewEntry,
        artifacts: webviewArtifacts
      },
      '*'
    );
  }

  function renderWebviewNow(ref: NonNullable<typeof contributionRef>) {
    const token = ++renderToken;
    rendering = true;
    renderError = null;
    if (!previewIframe?.contentWindow || !webviewEntry) {
      rendering = false;
      return;
    }
    if (!webviewInitialized) sendWebviewInit();
    previewIframe.contentWindow.postMessage(
      {
        type: 'mindstream-plugin-preview-render',
        token,
        input: {
          noteId,
          noteKind: ref.noteKind,
          body: source,
          sourceLanguage
        }
      },
      '*'
    );
  }

  function onWebviewMessage(event: MessageEvent) {
    if (!previewIframe || event.source !== previewIframe.contentWindow) return;
    const raw = event.data;
    if (!raw || typeof raw !== 'object') return;
    const message = raw as Record<string, unknown>;
    if (message.type === 'mindstream-plugin-preview-ready') {
      sendWebviewInit();
      return;
    }
    if (message.type === 'mindstream-plugin-preview-initialized') {
      webviewInitialized = true;
      scheduleRender(0);
      return;
    }
    if (message.type !== 'mindstream-plugin-preview-result') return;
    if (typeof message.token !== 'number' || message.token !== renderToken) {
      return;
    }
    rendering = false;
    if (typeof message.error === 'string') {
      renderError = message.error;
      diagnostics = [];
      return;
    }
    renderError = null;
    diagnostics = Array.isArray(message.diagnostics)
      ? message.diagnostics
          .map(parseDiagnostic)
          .filter((d): d is Diagnostic => d !== null)
      : [];
  }

  function parseRenderResult(
    value: unknown,
    fallbackMime: string
  ): {
    mime: string;
    text: string;
    dataBase64?: string;
    diagnostics: Diagnostic[];
  } {
    if (typeof value === 'string') {
      return { mime: fallbackMime, text: value, diagnostics: [] };
    }
    if (!value || typeof value !== 'object') {
      return { mime: fallbackMime, text: '', diagnostics: [] };
    }
    const raw = value as Record<string, unknown>;
    const preview =
      raw.preview && typeof raw.preview === 'object'
        ? (raw.preview as Record<string, unknown>)
        : raw;
    const text =
      typeof preview.text === 'string'
        ? preview.text
        : typeof raw.html === 'string'
          ? raw.html
          : typeof raw.svg === 'string'
            ? raw.svg
            : typeof raw.markdown === 'string'
              ? raw.markdown
              : '';
    const mime =
      typeof preview.mime === 'string'
        ? preview.mime
        : typeof raw.previewMime === 'string'
          ? raw.previewMime
          : fallbackMime;
    const dataBase64 =
      typeof preview.dataBase64 === 'string'
        ? preview.dataBase64
        : typeof raw.dataBase64 === 'string'
          ? raw.dataBase64
          : undefined;
    const parsedDiagnostics = Array.isArray(raw.diagnostics)
      ? raw.diagnostics
          .map(parseDiagnostic)
          .filter((d): d is Diagnostic => d !== null)
      : [];
    return { mime, text, dataBase64, diagnostics: parsedDiagnostics };
  }

  function parseDiagnostic(value: unknown): Diagnostic | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    if (typeof raw.message !== 'string') return null;
    const severity =
      raw.severity === 'error' ||
      raw.severity === 'warning' ||
      raw.severity === 'info'
        ? raw.severity
        : 'info';
    return { message: raw.message, severity };
  }

  function buildPreviewDocument(mime: string, text: string): string {
    if (mime === 'text/html') {
      return text.trim() ? text : '<!doctype html><html><body></body></html>';
    }
    if (mime === 'image/svg+xml') {
      return `<!doctype html><html><body>${text}</body></html>`;
    }
    return `<!doctype html><html><body><pre>${escapeHtml(text)}</pre></body></html>`;
  }

  function buildWebviewPreviewDocument(): string {
    const scriptSources = [
      "'unsafe-inline'",
      'blob:',
      "'wasm-unsafe-eval'",
      ...(webviewPreview?.allowEval ? ["'unsafe-eval'"] : [])
    ].join(' ');
    return [
      '<!doctype html><html><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scriptSources}; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:; worker-src blob:; connect-src 'none'">`,
      '<style>html,body,#plugin-preview-root{height:100%;margin:0}body{background:#fff;color:#111827;font:15px/1.55 system-ui,sans-serif}</style>',
      '</head><body><div id="plugin-preview-root"></div>',
      '<scr',
      `ipt>${webviewBootstrapScript()}</scr`,
      'ipt></body></html>'
    ].join('');
  }

  function webviewBootstrapScript(): string {
    return `
const parentWindow = window.parent;
let modulePromise = null;
let pendingRender = null;
let artifactUrls = new Map();
function mimeForArtifact(artifact) {
  if (artifact.kind === 'wasm') return 'application/wasm';
  if (artifact.kind === 'webScript' || /\\.m?js$/i.test(artifact.fileName || '')) return 'text/javascript';
  return 'application/octet-stream';
}
function renderPreview(preview) {
  const root = document.getElementById('plugin-preview-root');
  if (!root) return;
  if (!preview) {
    root.textContent = '';
    return;
  }
  const mime = preview.mime || 'text/plain';
  const text = typeof preview.text === 'string' ? preview.text : '';
  if (mime === 'text/html' || mime === 'image/svg+xml') {
    root.innerHTML = text;
  } else {
    root.textContent = text;
  }
}
async function init(message) {
  for (const url of artifactUrls.values()) URL.revokeObjectURL(url);
  artifactUrls = new Map();
  const artifacts = {};
  for (const artifact of message.artifacts || []) {
    const blob = new Blob([artifact.bytes], { type: mimeForArtifact(artifact) });
    const url = URL.createObjectURL(blob);
    artifactUrls.set(artifact.id, url);
    artifacts[artifact.id] = {
      id: artifact.id,
      kind: artifact.kind,
      fileName: artifact.fileName,
      bytes: artifact.bytes,
      url
    };
  }
  const entryUrl = URL.createObjectURL(new Blob([message.entry], { type: 'text/javascript' }));
  modulePromise = import(entryUrl).then((mod) => {
    URL.revokeObjectURL(entryUrl);
    return { mod, artifacts };
  });
  await modulePromise;
  parentWindow.postMessage({ type: 'mindstream-plugin-preview-initialized' }, '*');
  if (pendingRender) {
    const next = pendingRender;
    pendingRender = null;
    void render(next);
  }
}
async function render(message) {
  if (!modulePromise) {
    pendingRender = message;
    return;
  }
  try {
    const { mod, artifacts } = await modulePromise;
    if (typeof mod.render !== 'function') throw new Error('Preview module must export render(input, ctx)');
    const result = await mod.render(message.input, {
      artifacts,
      root: document.getElementById('plugin-preview-root')
    });
    renderPreview(result && result.preview ? result.preview : result);
    parentWindow.postMessage({
      type: 'mindstream-plugin-preview-result',
      token: message.token,
      diagnostics: result && Array.isArray(result.diagnostics) ? result.diagnostics : []
    }, '*');
  } catch (err) {
    parentWindow.postMessage({
      type: 'mindstream-plugin-preview-result',
      token: message.token,
      error: err instanceof Error ? err.message : String(err)
    }, '*');
  }
}
window.addEventListener('message', (event) => {
  const message = event.data || {};
  if (message.type === 'mindstream-plugin-preview-init') void init(message);
  if (message.type === 'mindstream-plugin-preview-render') void render(message);
});
parentWindow.postMessage({ type: 'mindstream-plugin-preview-ready' }, '*');
`;
  }

  function escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  onDestroy(() => {
    destroyed = true;
    loadToken += 1;
    renderToken += 1;
    sourceEditor?.flush();
    if (saveTimer) clearTimeout(saveTimer);
    if (renderTimer) clearTimeout(renderTimer);
    if (editorListener) {
      unregisterEditor(editorListener);
      editorListener = null;
    }
    window.removeEventListener('message', onWebviewMessage);
    void flushSave();
  });

  $effect(() => {
    window.addEventListener('message', onWebviewMessage);
    return () => window.removeEventListener('message', onWebviewMessage);
  });
</script>

<div class="flex h-full min-h-0 flex-col bg-background">
  {#if loading}
    <div
      class="flex h-full items-center justify-center text-sm text-muted-foreground"
    >
      <Loader2 class="mr-2 size-4 animate-spin" />
      Loading editor...
    </div>
  {:else if loadError}
    <div
      class="flex h-full items-center justify-center p-6 text-sm text-destructive"
    >
      <AlertTriangle class="mr-2 size-4" />
      {loadError}
    </div>
  {:else}
    <div
      class="flex shrink-0 items-center gap-1 border-b border-border bg-background pr-1"
    >
      <div class="min-w-0 flex-1">
        <PluginSourceToolbar
          noteKind={storedNoteKind}
          getView={() => sourceEditor?.getView() ?? null}
          class="bg-background"
        />
      </div>
      {#if rendering}
        <Loader2 class="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      {/if}
      {#if !previewBlocked}
        <EditorModeToggle
          value={viewMode}
          previewIcon={contributionRef?.contribution.viewModePreviewIcon}
          onCycle={cycleViewMode}
        />
      {/if}
    </div>
    {#if previewBlocked && !mobile}
      <div
        class="flex shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
      >
        <AlertTriangle class="size-3.5 shrink-0" />
        <span class="min-w-0 flex-1">
          {tUi('plugins.nativeTool.missing').replace(
            '{tool}',
            toolBinaryName || (requiredToolId ?? '')
          )}
        </span>
        <button
          type="button"
          class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          disabled={toolState === 'checking'}
          onclick={recheckTool}
        >
          <RefreshCw
            class="size-3 {toolState === 'checking' ? 'animate-spin' : ''}"
          />
          {tUi('plugins.nativeTool.recheck')}
        </button>
      </div>
    {/if}
    <div
      bind:this={editorRegionEl}
      class="grid min-h-0 flex-1 grid-cols-1 {splitMode
        ? 'md:grid-cols-2'
        : ''}"
    >
      {#if showSource}
        <section
          class="flex min-h-0 flex-col border-b border-border md:border-b-0"
          class:md:border-r={splitMode}
        >
          <SourceEditor
            bind:this={sourceEditor}
            getInitialText={() => source}
            language={sourceLanguage}
            tabSize={sourceTabSize}
            onInput={onSourceInput}
            {autoPairEnabled}
          />
        </section>
      {/if}
      {#if showPreview}
        <section class="relative flex min-h-0 flex-col">
          {#if renderError}
            <div
              class="absolute left-3 right-3 top-3 z-10 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
            >
              {renderError}
            </div>
          {/if}
          {#if serviceUsable}
            {#if serviceIframeSrc}
              <!-- The live preview server (e.g. tinymist) serves its own
                   click-to-source frontend. We load it through our reverse
                   proxy so an app-theme background is injected behind the
                   pages; on `fallback` it's the server's origin directly. -->
              <div class="min-h-0 flex-1 bg-muted/40">
                <div
                  class="h-full w-full overflow-hidden border border-border bg-white shadow-sm"
                >
                  <iframe
                    class="h-full w-full"
                    title="Live plugin preview"
                    src={serviceIframeSrc}
                  ></iframe>
                </div>
              </div>
            {:else}
              <div
                class="flex min-h-0 flex-1 items-center justify-center bg-muted/40 text-sm text-muted-foreground"
              >
                <Loader2 class="mr-2 size-4 animate-spin" />
                {tUi('plugins.preview.starting')}
              </div>
            {/if}
          {:else if previewMime === 'application/pdf'}
            {#if previewData}
              <PluginPdfPreview bytes={previewData} />
            {:else}
              <div class="min-h-0 flex-1 bg-muted/40"></div>
            {/if}
          {:else}
            <iframe
              bind:this={previewIframe}
              class="min-h-0 flex-1 bg-white"
              title="Plugin note preview"
              sandbox={webviewPreview ? 'allow-scripts' : ''}
              srcdoc={previewSrcdoc}
            ></iframe>
          {/if}
        </section>
      {/if}
    </div>
    {#if diagnostics.length > 0}
      <ul class="border-t border-border bg-muted/30 px-3 py-2 text-xs">
        {#each diagnostics as diagnostic}
          <li class:font-medium={diagnostic.severity === 'error'}>
            {diagnostic.message}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>
