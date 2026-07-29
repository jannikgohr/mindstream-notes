<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { EditorView } from '@codemirror/view';
  import { AlertTriangle, Loader2 } from '@lucide/svelte';
  import { loadNote } from '$lib/api';
  import {
    pluginsArtifactsStatus,
    pluginsDownloadArtifact,
    pluginsReadArtifact,
    pluginsRunScript
  } from '$lib/api/plugins';
  import { setNoteBody } from '$lib/stores/tree.svelte';
  import { pluginNoteKind } from '$lib/plugins/registry.svelte';
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
  const showSource = $derived(viewMode !== 'wysiwyg');
  const showPreview = $derived(viewMode !== 'source');
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
        loadError = err instanceof Error ? err.message : String(err);
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
    scheduleRender(debounceMs);
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
      const parsed = parseRenderResult(
        raw,
        ref.contribution.render.previewMime ?? 'text/plain'
      );
      previewMime = parsed.mime;
      previewText = parsed.text;
      diagnostics = parsed.diagnostics;
    } catch (err) {
      if (destroyed || token !== renderToken) return;
      renderError = err instanceof Error ? err.message : String(err);
      diagnostics = [];
    } finally {
      if (!destroyed && token === renderToken) rendering = false;
    }
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
  ): { mime: string; text: string; diagnostics: Diagnostic[] } {
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
    const parsedDiagnostics = Array.isArray(raw.diagnostics)
      ? raw.diagnostics
          .map(parseDiagnostic)
          .filter((d): d is Diagnostic => d !== null)
      : [];
    return { mime, text, diagnostics: parsedDiagnostics };
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
    return [
      '<!doctype html><html><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline' blob: 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:; worker-src blob:; connect-src 'none'\">",
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
      <EditorModeToggle
        value={viewMode}
        previewIcon={contributionRef?.contribution.viewModePreviewIcon}
        onCycle={cycleViewMode}
      />
    </div>
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
          <iframe
            bind:this={previewIframe}
            class="min-h-0 flex-1 bg-white"
            title="Plugin note preview"
            sandbox={webviewPreview ? 'allow-scripts' : ''}
            srcdoc={previewSrcdoc}
          ></iframe>
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
