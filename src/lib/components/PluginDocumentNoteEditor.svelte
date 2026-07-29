<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { EditorView } from '@codemirror/view';
  import { AlertTriangle, Loader2 } from '@lucide/svelte';
  import { loadNote } from '$lib/api';
  import { pluginsRunScript } from '$lib/api/plugins';
  import { setNoteBody } from '$lib/stores/tree.svelte';
  import { pluginNoteKind } from '$lib/plugins/registry.svelte';
  import { getSettingValue } from '$lib/settings/store.svelte';
  import SourceEditor from '$lib/editor/source/SourceEditor.svelte';
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
  let editorRegionEl: HTMLDivElement | null = $state(null);
  let sourceEditor = $state<{
    setText: (text: string) => void;
    flush: () => void;
    focus: () => void;
    getView: () => EditorView | null;
  } | null>(null);
  let editorListener: EditorListener | null = $state(null);

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
    if (!editorRegionEl) return;
    const listener: EditorListener = {
      kind: 'plugin',
      host: editorRegionEl,
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
    registerEditor(listener);
    return () => {
      unregisterEditor(listener);
      if (editorListener === listener) editorListener = null;
    };
  });

  $effect(() => {
    if (!editorRegionEl || !editorListener) return;
    const listener = editorListener;
    const promote = () => registerEditor(listener);
    editorRegionEl.addEventListener('focusin', promote);
    return () => editorRegionEl?.removeEventListener('focusin', promote);
  });

  function onSourceInput(value: string) {
    source = value;
    scheduleSave();
    scheduleRender(debounceMs);
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

  function parseRenderResult(
    value: unknown,
    fallbackMime: string
  ): { mime: string; text: string; diagnostics: Diagnostic[] } {
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
    if (mime === 'text/html') return text;
    if (mime === 'image/svg+xml') {
      return `<!doctype html><html><body>${text}</body></html>`;
    }
    return `<!doctype html><html><body><pre>${escapeHtml(text)}</pre></body></html>`;
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
    void flushSave();
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
      class="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background pr-2"
    >
      <PluginSourceToolbar
        noteKind={storedNoteKind}
        getView={() => sourceEditor?.getView() ?? null}
        class="min-w-0 flex-1 bg-background"
      />
      {#if rendering}
        <Loader2 class="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      {/if}
    </div>
    <div
      bind:this={editorRegionEl}
      class="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2"
    >
      <section
        class="flex min-h-0 flex-col border-b border-border md:border-b-0 md:border-r"
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
      <section class="flex min-h-0 flex-col">
        {#if renderError}
          <div
            class="m-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
          >
            {renderError}
          </div>
        {/if}
        <iframe
          class="min-h-0 flex-1 bg-white"
          title="Plugin note preview"
          sandbox=""
          srcdoc={iframeSrcdoc}
        ></iframe>
      </section>
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
