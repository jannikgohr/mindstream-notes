<script lang="ts">
  /**
   * Modal for importing a signature from a photo — either a live camera
   * capture or a picked image file. Both paths produce a `RasterImage`
   * and share the same pure tracing pipeline (signature-trace.ts); this
   * component only owns the acquisition UI and the threshold preview.
   *
   * Camera strategy: on Android the webview's getUserMedia permission
   * plumbing is unreliable, so "take photo" opens the OS camera app via
   * a file input with `capture` — same decode path as a picked file. On
   * desktop we try a live getUserMedia preview first and fall back to
   * the capture input if the camera is unavailable or denied.
   *
   * Reset behaviour mirrors SignaturePadDialog: every open starts from
   * the source picker with no leftover photo or stream.
   */

  import { Camera, ImageUp, RefreshCw } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { isAndroid } from '$lib/platform';
  import { strokePointsAttr } from './stroke-utils';
  import {
    traceSignature,
    type RasterImage,
    type TracedSignature
  } from './signature-trace';
  import {
    openCameraStream,
    rasterFromBlob,
    rasterFromVideo,
    stopCameraStream
  } from './signature-import-image';
  import type { PdfSignatureSnapshot } from './types';

  interface Props {
    open: boolean;
    onCancel: () => void;
    onSave: (signature: PdfSignatureSnapshot) => void;
  }
  let { open, onCancel, onSave }: Props = $props();

  type Mode = 'pick' | 'camera' | 'adjust';

  let mode = $state<Mode>('pick');
  let raster = $state<RasterImage | null>(null);
  let traced = $state<TracedSignature | null>(null);
  let cameraError = $state(false);
  let decodeError = $state(false);
  let stream: MediaStream | null = null;
  let videoEl = $state<HTMLVideoElement | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let captureInput = $state<HTMLInputElement | null>(null);
  let retraceTimer: ReturnType<typeof setTimeout> | null = null;

  function closeCamera() {
    stopCameraStream(stream);
    stream = null;
  }

  function reset() {
    closeCamera();
    if (retraceTimer) clearTimeout(retraceTimer);
    retraceTimer = null;
    mode = 'pick';
    raster = null;
    traced = null;
    cameraError = false;
    decodeError = false;
  }

  $effect(() => {
    if (open) reset();
    return () => {
      closeCamera();
      if (retraceTimer) clearTimeout(retraceTimer);
    };
  });

  // Attach the stream once the <video> exists (it renders after the
  // mode flips, so this can't happen inline in startCamera).
  $effect(() => {
    if (mode === 'camera' && videoEl && stream) {
      videoEl.srcObject = stream;
      void videoEl.play().catch(() => {
        /* autoplay rejection surfaces as a black preview; capture still works */
      });
    }
  });

  function processRaster(image: RasterImage) {
    raster = image;
    // Fresh photo → fresh automatic threshold.
    traced = traceSignature(image);
    mode = 'adjust';
  }

  async function onFilePicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    decodeError = false;
    try {
      processRaster(await rasterFromBlob(file));
    } catch {
      decodeError = true;
    }
  }

  async function startCamera() {
    cameraError = false;
    if (isAndroid()) {
      // OS camera app via the capture input — most reliable path in the
      // Android webview, and it reuses the file decode pipeline.
      captureInput?.click();
      return;
    }
    try {
      stream = await openCameraStream();
      mode = 'camera';
    } catch {
      cameraError = true;
    }
  }

  function captureFrame() {
    if (!videoEl) return;
    try {
      const image = rasterFromVideo(videoEl);
      closeCamera();
      processRaster(image);
    } catch {
      /* no frame yet — user can press capture again */
    }
  }

  function backToPick() {
    closeCamera();
    mode = 'pick';
    traced = null;
    raster = null;
  }

  function onThresholdInput(event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (retraceTimer) clearTimeout(retraceTimer);
    // Debounce: retracing a 1000px photo takes tens of ms — fine per
    // adjustment, too slow for every pixel of a slider drag.
    retraceTimer = setTimeout(() => {
      retraceTimer = null;
      if (raster) traced = traceSignature(raster, { threshold: value });
    }, 120);
  }

  function save() {
    if (!traced || traced.strokes.length === 0) return;
    onSave({
      id: crypto.randomUUID(),
      width: traced.width,
      height: traced.height,
      strokes: traced.strokes
    });
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
    role="presentation"
  >
    <div
      class="flex w-[min(34rem,100%)] flex-col rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
      role="dialog"
      aria-modal="true"
      aria-label={tUi('pdf.signature.import.title')}
    >
      <div
        class="flex h-9 items-center justify-between border-b border-border px-3"
      >
        <div class="text-xs font-medium text-muted-foreground">
          {tUi('pdf.signature.import.title')}
        </div>
        <Button
          variant="ghost"
          size="sm"
          class="h-7 px-2 text-xs"
          onclick={onCancel}
        >
          {tUi('pdf.signature.import.cancel')}
        </Button>
      </div>

      <div class="p-3">
        {#if mode === 'pick'}
          <div class="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              class="flex flex-1 flex-col items-center gap-2 rounded-md border border-input p-6 transition-colors hover:bg-accent hover:text-accent-foreground"
              onclick={startCamera}
            >
              <Camera class="size-6" aria-hidden="true" />
              <span class="text-sm"
                >{tUi('pdf.signature.import.takePhoto')}</span
              >
            </button>
            <button
              type="button"
              class="flex flex-1 flex-col items-center gap-2 rounded-md border border-input p-6 transition-colors hover:bg-accent hover:text-accent-foreground"
              onclick={() => fileInput?.click()}
            >
              <ImageUp class="size-6" aria-hidden="true" />
              <span class="text-sm">
                {tUi('pdf.signature.import.chooseImage')}
              </span>
            </button>
          </div>
          {#if cameraError}
            <p class="mt-2 text-xs text-muted-foreground">
              {tUi('pdf.signature.import.cameraError')}
            </p>
          {/if}
          {#if decodeError}
            <p class="mt-2 text-xs text-destructive">
              {tUi('pdf.signature.import.decodeError')}
            </p>
          {/if}
        {:else if mode === 'camera'}
          <!-- svelte-ignore a11y_media_has_caption — live camera preview -->
          <video
            bind:this={videoEl}
            autoplay
            playsinline
            muted
            class="aspect-video w-full rounded-md border border-input bg-black object-cover"
          ></video>
        {:else if traced}
          <svg
            role="img"
            aria-label={tUi('pdf.signature.preview')}
            class="aspect-[420/168] w-full rounded-md border border-input bg-white"
            viewBox="0 0 {traced.width} {traced.height}"
            preserveAspectRatio="xMidYMid meet"
          >
            {#each traced.strokes as stroke (stroke.id)}
              <polyline
                points={strokePointsAttr(stroke.points)}
                fill="none"
                stroke={stroke.color}
                stroke-width={stroke.width}
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            {/each}
          </svg>
          {#if traced.strokes.length === 0}
            <p class="mt-2 text-xs text-muted-foreground">
              {tUi('pdf.signature.import.empty')}
            </p>
          {/if}
          <label class="mt-3 flex items-center gap-2 text-xs">
            <span class="shrink-0 text-muted-foreground">
              {tUi('pdf.signature.import.threshold')}
            </span>
            <input
              type="range"
              min="0"
              max="255"
              step="1"
              value={traced.threshold}
              oninput={onThresholdInput}
              class="flex-1"
            />
          </label>
        {/if}
      </div>

      <div
        class="flex h-10 items-center justify-between border-t border-border px-3"
      >
        {#if mode === 'camera'}
          <Button
            variant="ghost"
            size="sm"
            class="h-7 px-2 text-xs"
            onclick={backToPick}
          >
            {tUi('pdf.signature.import.back')}
          </Button>
          <Button size="sm" class="h-7 px-2 text-xs" onclick={captureFrame}>
            {tUi('pdf.signature.import.capture')}
          </Button>
        {:else if mode === 'adjust'}
          <Button
            variant="ghost"
            size="sm"
            class="h-7 gap-1 px-2 text-xs"
            onclick={backToPick}
          >
            <RefreshCw class="size-3.5" aria-hidden="true" />
            {tUi('pdf.signature.import.retake')}
          </Button>
          <Button
            size="sm"
            class="h-7 px-2 text-xs"
            onclick={save}
            disabled={!traced || traced.strokes.length === 0}
          >
            {tUi('pdf.signature.import.save')}
          </Button>
        {:else}
          <div></div>
        {/if}
      </div>
    </div>
  </div>

  <input
    bind:this={fileInput}
    type="file"
    accept="image/*"
    class="hidden"
    onchange={onFilePicked}
  />
  <input
    bind:this={captureInput}
    type="file"
    accept="image/*"
    capture="environment"
    class="hidden"
    onchange={onFilePicked}
  />
{/if}
