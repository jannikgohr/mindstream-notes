<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    drawingSaveInkState,
    loadNote,
    type DrawingToolbarSettings,
    type DrawingToolbarSettingsPayload
  } from '$lib/api';
  import {
    getSettingValue,
    hasSettingValue,
    setSettingValue
  } from '$lib/settings/store.svelte';
  import {
    setNoteStatus,
    type SavingState
  } from '$lib/stores/note-status.svelte';

  interface Props {
    noteId: string;
    ariaLabel: string;
  }

  let { noteId, ariaLabel }: Props = $props();

  const SAVE_DEBOUNCE_MS = 800;

  type WebInkHandleInstance = {
    start: (
      canvas: HTMLCanvasElement,
      initialState: Uint8Array,
      initialToolbarSettings: DrawingToolbarSettings,
      onChange: (bytes: Uint8Array) => void,
      onToolbarSettings: (settings: DrawingToolbarSettingsPayload) => void
    ) => Promise<void>;
    destroy?: () => void;
  };

  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let savingState = $state<SavingState>('idle');
  let toolbarSettingsReady = false;
  let disposed = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingState: number[] | null = null;
  let handle: WebInkHandleInstance | null = null;

  const INK_TOOL_SETTING = 'editor.ink.tool';
  const INK_COLOR_SETTING = 'editor.ink.color';
  const INK_WIDTH_SETTING = 'editor.ink.width';
  const INK_FINGER_SETTING = 'editor.ink.fingerDrawing';
  const INK_PAGE_THEME_SETTING = 'editor.ink.pageTheme';

  $effect(() => {
    setNoteStatus(noteId, {
      collabConfigured: false,
      collabOnline: false,
      savingState,
      isTrashed: false
    });
  });

  function clearSaveTimer() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  async function flushPendingState() {
    const state = pendingState;
    if (!state || disposed) return;
    pendingState = null;
    savingState = 'saving';
    try {
      await drawingSaveInkState(noteId, state);
      savingState = 'saved';
    } catch (err) {
      pendingState = state;
      savingState = 'error';
      console.warn('[ink-web] failed to save note', err);
    }
  }

  function scheduleSave(bytes: Uint8Array) {
    pendingState = Array.from(bytes);
    savingState = 'pending';
    clearSaveTimer();
    saveTimer = setTimeout(() => void flushPendingState(), SAVE_DEBOUNCE_MS);
  }

  function normalizeInkTool(value: unknown): 'pen' | 'eraser' {
    return value === 'eraser' ? 'eraser' : 'pen';
  }

  function normalizeInkPageTheme(value: unknown): 'light' | 'system' {
    return value === 'system' ? 'system' : 'light';
  }

  function normalizeInkWidth(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? Math.min(12, Math.max(0.5, n)) : 4;
  }

  function colorHexToArgb(value: unknown): number {
    const raw = typeof value === 'string' ? value : '#000000';
    const hex = raw.startsWith('#') ? raw.slice(1) : raw;
    const expanded =
      hex.length === 3
        ? hex
            .split('')
            .map((c) => c + c)
            .join('')
        : hex.slice(0, 6);
    const rgb = Number.parseInt(expanded.padEnd(6, '0'), 16);
    return (0xff000000 | (Number.isFinite(rgb) ? rgb : 0)) >>> 0;
  }

  function argbToColorHex(argb: number): string {
    return `#${(argb & 0x00ffffff).toString(16).padStart(6, '0')}`;
  }

  function currentToolbarSettings(): DrawingToolbarSettings {
    return {
      tool: normalizeInkTool(getSettingValue(INK_TOOL_SETTING)),
      colorArgb: colorHexToArgb(getSettingValue(INK_COLOR_SETTING)),
      width: normalizeInkWidth(getSettingValue(INK_WIDTH_SETTING)),
      fingerDrawingAllowed: hasSettingValue(INK_FINGER_SETTING)
        ? Boolean(getSettingValue(INK_FINGER_SETTING))
        : null,
      pageThemeMode: normalizeInkPageTheme(
        getSettingValue(INK_PAGE_THEME_SETTING)
      )
    };
  }

  async function saveToolbarSettings(
    payload: DrawingToolbarSettingsPayload
  ): Promise<void> {
    await Promise.all([
      setSettingValue(INK_TOOL_SETTING, normalizeInkTool(payload.tool)),
      setSettingValue(INK_COLOR_SETTING, argbToColorHex(payload.colorArgb)),
      setSettingValue(INK_WIDTH_SETTING, normalizeInkWidth(payload.width)),
      setSettingValue(INK_FINGER_SETTING, payload.fingerDrawingAllowed),
      setSettingValue(
        INK_PAGE_THEME_SETTING,
        normalizeInkPageTheme(payload.pageThemeMode)
      )
    ]);
  }

  onMount(async () => {
    if (!canvasEl) return;
    const note = await loadNote(noteId);
    if (disposed || !canvasEl) return;

    const mod = await import('$lib/ink-web/pkg/ink_egui_web.js');
    if (disposed || !canvasEl) return;

    const init = mod.default as unknown as () => Promise<unknown>;
    await init();

    const WebInkHandle = mod.WebInkHandle as new () => WebInkHandleInstance;

    handle = new WebInkHandle();
    await handle.start(
      canvasEl,
      new Uint8Array(note.yrs_state),
      currentToolbarSettings(),
      (bytes: Uint8Array) => scheduleSave(bytes),
      (settings: DrawingToolbarSettingsPayload) => {
        if (!toolbarSettingsReady) return;
        void saveToolbarSettings(settings).catch((err) => {
          console.warn('[ink-web-toolbar] failed to save settings', err);
        });
      }
    );
    toolbarSettingsReady = true;
  });

  onDestroy(() => {
    clearSaveTimer();
    void flushPendingState();
    disposed = true;
    handle?.destroy?.();
    handle = null;
  });
</script>

<canvas
  bind:this={canvasEl}
  class="block h-full w-full bg-muted/20"
  aria-label={ariaLabel}
></canvas>
