<script lang="ts">
  /**
   * POC editor for `note_kind === 'ink'` notes.
   *
   * Android: just toggles the native SurfaceView injected by
   * `io.crates.drawing.Drawing` via two Tauri commands. The actual
   * pixels come from `src-tauri/src/drawing/render.rs` running on its
   * own thread; this component renders nothing visible — the
   * SurfaceView sits on top of the WebView with `setZOrderOnTop(true)`.
   *
   * Desktop: the native layer isn't implemented yet (Phase 2). Show a
   * placeholder so the note opens cleanly even when a phone created
   * the row and synced it down.
   *
   * Ephemeral by design — POC scope. Strokes vanish when the note
   * closes; no save, no toolbar, no eraser. Persistence + UI live
   * behind future steps in docs/native-egui-layer.
   */
  import { onDestroy, onMount } from 'svelte';
  import { PenTool } from 'lucide-svelte';
  import { drawingHide, drawingShow } from '$lib/api';
  import { isAndroid } from '$lib/platform';
  import { setMobileScreen } from '$lib/mobile/state.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    noteId: string;
  }
  // The noteId is unused for the ephemeral POC — strokes aren't
  // associated with any note yet — but kept on the props so the
  // signature matches NoteEditor / FreeformNoteEditor and the dispatch
  // sites don't need a special case.
  let { noteId: _noteId }: Props = $props();

  let mountedAndroid = false;
  let backCleanup: (() => void) | null = null;

  onMount(() => {
    if (!isAndroid()) return;
    // The native egui toolbar's Back button bounces through Rust →
    // Kotlin → webView.evaluateJavascript, which dispatches this
    // CustomEvent on the WebView's window. We respond by flipping
    // the mobile shell back to its home screen, which unmounts this
    // component, which onDestroy below calls drawingHide on. That's
    // the path that actually detaches the SurfaceView + drops the
    // wgpu state cleanly — going through JS keeps the back path
    // symmetric whether the user taps the in-egui Back button, an
    // in-app back arrow we add later, or anything else.
    const onBack = () => setMobileScreen('home');
    window.addEventListener('drawing-back', onBack);
    backCleanup = () => window.removeEventListener('drawing-back', onBack);
    void drawingShow();
    mountedAndroid = true;
  });

  onDestroy(() => {
    backCleanup?.();
    backCleanup = null;
    // Use the at-mount platform check rather than re-querying — a
    // hide call that never had a matching show is a backend no-op,
    // but skipping it keeps the trace clean.
    if (mountedAndroid) void drawingHide();
  });
</script>

{#if isAndroid()}
  <!-- Empty viewport. The native SurfaceView paints above the WebView
       via setZOrderOnTop(true); this div exists only so the editor
       layout has a host element and so the WebView has a measurable
       region for hit-testing back into the Svelte shell if we ever
       drop zOrderOnTop. -->
  <div class="h-full w-full"></div>
{:else}
  <div
    class="flex h-full w-full items-center justify-center p-6 text-center"
  >
    <div
      class="flex max-w-md flex-col items-center gap-3 rounded-lg border border-border bg-card p-6"
    >
      <PenTool class="size-8 text-muted-foreground" aria-hidden="true" />
      <p class="text-sm font-medium text-foreground">
        {tUi('editor.ink.desktopPlaceholderTitle')}
      </p>
      <p class="text-sm text-muted-foreground">
        {tUi('editor.ink.desktopPlaceholderMessage')}
      </p>
    </div>
  </div>
{/if}
