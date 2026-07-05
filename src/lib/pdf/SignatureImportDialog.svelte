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
   * Paper scan: every acquired photo runs through paper detection
   * (paper-detect.ts). When a sheet is found it is perspective-corrected
   * and the trace runs on the rectified crop — full resolution budget on
   * the paper. The live camera preview overlays the detected quad as
   * capture guidance, and the adjust view offers a crop on/off toggle so
   * a false detection never blocks the user.
   *
   * Reset behaviour mirrors SignaturePadDialog: every open starts from
   * the source picker with no leftover photo or stream.
   */

  import { Camera, Crop, ImageUp, RefreshCw, RotateCw } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { isAndroid } from '$lib/platform';
  import SignatureStrokes from './SignatureStrokes.svelte';
  import {
    traceSignature,
    type RasterImage,
    type TracedSignature
  } from './signature-trace';
  import {
    detectPaperQuad,
    downscaleRaster,
    orderQuad,
    rectifyPaper,
    rotateRaster90,
    type PaperQuad,
    type QuadPoint
  } from './paper-detect';
  import {
    openCameraStream,
    rasterFromBlob,
    rasterFromVideo,
    stopCameraStream,
    transparentSignatureImageFromRaster,
    IMPORT_DECODE_MAX_DIMENSION,
    IMPORT_MAX_DIMENSION
  } from './signature-import-image';
  import type { PdfSignatureImage, PdfSignatureSnapshot } from './types';

  interface Props {
    open: boolean;
    onCancel: () => void;
    onSave: (signature: PdfSignatureSnapshot) => void;
  }
  let { open, onCancel, onSave }: Props = $props();

  type Mode = 'pick' | 'camera' | 'adjust' | 'crop';

  /** Working width for the throttled live-preview paper detection. */
  const LIVE_DETECT_WIDTH = 320;

  let mode = $state<Mode>('pick');
  // Two trace sources per photo: the rectified paper crop (when a paper
  // was detected or the user set one manually) and the plain downscaled
  // frame. `paperCrop` picks.
  let wholeFrameRaster = $state<RasterImage | null>(null);
  let rectifiedRaster = $state<RasterImage | null>(null);
  let paperCrop = $state(true);
  // Full-resolution decode kept for the manual crop editor: re-warping
  // with user-adjusted corners must sample the original, not a crop.
  let sourceRaster = $state<RasterImage | null>(null);
  let detectedQuad = $state<PaperQuad | null>(null);
  /** Corners being edited in crop mode (source-image pixels). */
  let editedQuad = $state<QuadPoint[] | null>(null);
  let cropCanvas = $state<HTMLCanvasElement | null>(null);
  let cropSvg = $state<SVGSVGElement | null>(null);
  let dragIndex = $state<number | null>(null);
  let traced = $state<TracedSignature | null>(null);
  let signatureImage = $state<PdfSignatureImage | null>(null);
  let cameraError = $state(false);
  let decodeError = $state(false);
  let stream: MediaStream | null = null;
  let videoEl = $state<HTMLVideoElement | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let captureInput = $state<HTMLInputElement | null>(null);
  let retraceTimer: ReturnType<typeof setTimeout> | null = null;
  let cameraRequestId = 0;

  // Live capture guidance: last detected quad in preview-frame coords.
  let liveQuad = $state<PaperQuad | null>(null);
  let liveFrame = $state<{ width: number; height: number } | null>(null);
  let detectTimer: ReturnType<typeof setInterval> | null = null;
  let detecting = false;

  function stopLiveDetection() {
    if (detectTimer) clearInterval(detectTimer);
    detectTimer = null;
    liveQuad = null;
    liveFrame = null;
  }

  function startLiveDetection() {
    stopLiveDetection();
    detectTimer = setInterval(() => {
      if (detecting || !videoEl || !videoEl.videoWidth) return;
      detecting = true;
      try {
        const frame = rasterFromVideo(videoEl, LIVE_DETECT_WIDTH);
        liveQuad = detectPaperQuad(frame);
        liveFrame = { width: frame.width, height: frame.height };
      } catch {
        liveQuad = null;
      } finally {
        detecting = false;
      }
    }, 250);
  }

  function closeCamera() {
    cameraRequestId += 1;
    stopLiveDetection();
    stopCameraStream(stream);
    stream = null;
  }

  function reset() {
    closeCamera();
    if (retraceTimer) clearTimeout(retraceTimer);
    retraceTimer = null;
    mode = 'pick';
    wholeFrameRaster = null;
    rectifiedRaster = null;
    paperCrop = true;
    sourceRaster = null;
    detectedQuad = null;
    editedQuad = null;
    dragIndex = null;
    traced = null;
    signatureImage = null;
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
      startLiveDetection();
      return () => stopLiveDetection();
    }
  });

  function activeTraceRaster(): RasterImage | null {
    return paperCrop && rectifiedRaster ? rectifiedRaster : wholeFrameRaster;
  }

  function traceRaster(
    raster: RasterImage,
    sensitivity?: number
  ): TracedSignature {
    const next = traceSignature(
      raster,
      typeof sensitivity === 'number' ? { sensitivity } : {}
    );
    signatureImage =
      transparentSignatureImageFromRaster(raster, {
        sensitivity: next.sensitivity
      }) ?? null;
    return next;
  }

  function processRaster(image: RasterImage, sensitivity?: number) {
    // Photos are decoded above the trace cap so the paper crop keeps
    // real resolution; the whole-frame fallback downscales as before.
    sourceRaster = image;
    detectedQuad = detectPaperQuad(image);
    editedQuad = null;
    rectifiedRaster = detectedQuad ? rectifyPaper(image, detectedQuad) : null;
    paperCrop = rectifiedRaster !== null;
    wholeFrameRaster = downscaleRaster(image, IMPORT_MAX_DIMENSION);
    // Fresh photo → fresh automatic threshold (rotation passes the
    // user's adjusted sensitivity through — same ink, same threshold).
    traced = traceRaster(activeTraceRaster()!, sensitivity);
    mode = 'adjust';
  }

  function rotatePhoto() {
    if (!sourceRaster) return;
    if (retraceTimer) clearTimeout(retraceTimer);
    retraceTimer = null;
    // Re-run the whole pipeline: the paper quad, rectified crop, and
    // manual crop corners all live in source coordinates and would be
    // stale after rotation.
    processRaster(rotateRaster90(sourceRaster), traced?.sensitivity);
  }

  function togglePaperCrop(event: Event) {
    paperCrop = (event.currentTarget as HTMLInputElement).checked;
    if (retraceTimer) clearTimeout(retraceTimer);
    retraceTimer = null;
    const raster = activeTraceRaster();
    // Different pixels → recompute the automatic threshold.
    if (raster) traced = traceRaster(raster);
  }

  /* --- Manual crop editor -------------------------------------------- */

  /** Starting quad when nothing was detected: an 8%-inset frame. */
  function defaultQuad(raster: RasterImage): QuadPoint[] {
    const mx = raster.width * 0.08;
    const my = raster.height * 0.08;
    return [
      { x: mx, y: my },
      { x: raster.width - mx, y: my },
      { x: raster.width - mx, y: raster.height - my },
      { x: mx, y: raster.height - my }
    ];
  }

  function openCropEditor() {
    if (!sourceRaster) return;
    if (!editedQuad) {
      editedQuad = (detectedQuad ?? defaultQuad(sourceRaster)).map((p) => ({
        ...p
      }));
    }
    mode = 'crop';
  }

  function resetCropQuad() {
    if (!sourceRaster) return;
    editedQuad = (detectedQuad ?? defaultQuad(sourceRaster)).map((p) => ({
      ...p
    }));
  }

  function applyCrop() {
    if (!sourceRaster || !editedQuad || editedQuad.length !== 4) return;
    // The user placed these corners deliberately — no automatic inset.
    rectifiedRaster = rectifyPaper(sourceRaster, orderQuad(editedQuad), {
      inset: 0
    });
    paperCrop = true;
    traced = traceRaster(rectifiedRaster);
    mode = 'adjust';
  }

  function closeCropEditor() {
    dragIndex = null;
    mode = 'adjust';
  }

  /** Pointer position in source-image pixels. The overlay SVG covers
   *  the canvas exactly (same aspect, preserveAspectRatio none), so the
   *  mapping is a plain linear scale of the bounding rect. */
  function cropPointFromEvent(event: PointerEvent): QuadPoint | null {
    if (!cropSvg || !sourceRaster) return null;
    const rect = cropSvg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = ((event.clientX - rect.left) / rect.width) * sourceRaster.width;
    const y = ((event.clientY - rect.top) / rect.height) * sourceRaster.height;
    return {
      x: Math.min(sourceRaster.width, Math.max(0, x)),
      y: Math.min(sourceRaster.height, Math.max(0, y))
    };
  }

  function onHandleDown(event: PointerEvent, index: number) {
    event.preventDefault();
    try {
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
    } catch {
      /* capture is best-effort — dragging still works while the pointer
         stays over the editor */
    }
    dragIndex = index;
  }

  function onHandleMove(event: PointerEvent) {
    if (dragIndex === null || !editedQuad) return;
    const point = cropPointFromEvent(event);
    if (!point) return;
    editedQuad = editedQuad.map((p, i) => (i === dragIndex ? point : p));
  }

  function onHandleUp() {
    dragIndex = null;
  }

  // Paint the source photo whenever the crop editor becomes visible.
  $effect(() => {
    if (mode !== 'crop' || !cropCanvas || !sourceRaster) return;
    cropCanvas.width = sourceRaster.width;
    cropCanvas.height = sourceRaster.height;
    const ctx = cropCanvas.getContext('2d');
    // Copy: ImageData wants a Uint8ClampedArray backed by a plain
    // ArrayBuffer, which the RasterImage type doesn't guarantee.
    ctx?.putImageData(
      new ImageData(
        new Uint8ClampedArray(sourceRaster.data),
        sourceRaster.width,
        sourceRaster.height
      ),
      0,
      0
    );
  });

  const cropHandleRadius = $derived(
    sourceRaster ? Math.max(sourceRaster.width, sourceRaster.height) * 0.018 : 8
  );
  const cropQuadPoints = $derived(
    editedQuad ? editedQuad.map((p) => `${p.x},${p.y}`).join(' ') : ''
  );
  /** Even-odd shade: whole frame minus the quad. */
  const cropShadePath = $derived(
    sourceRaster && editedQuad
      ? `M0 0 H${sourceRaster.width} V${sourceRaster.height} H0 Z ` +
          `M${editedQuad.map((p) => `${p.x} ${p.y}`).join(' L')} Z`
      : ''
  );

  async function onFilePicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    decodeError = false;
    try {
      processRaster(await rasterFromBlob(file, IMPORT_DECODE_MAX_DIMENSION));
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
    const requestId = (cameraRequestId += 1);
    try {
      const nextStream = await openCameraStream();
      if (requestId !== cameraRequestId || !open) {
        stopCameraStream(nextStream);
        return;
      }
      stream = nextStream;
      mode = 'camera';
    } catch {
      if (requestId === cameraRequestId && open) cameraError = true;
    }
  }

  function captureFrame() {
    if (!videoEl) return;
    try {
      const image = rasterFromVideo(videoEl, IMPORT_DECODE_MAX_DIMENSION);
      closeCamera();
      // The capture re-runs detection on the full-resolution frame; the
      // preview quad is guidance only.
      processRaster(image);
    } catch {
      /* no frame yet — user can press capture again */
    }
  }

  function backToPick() {
    closeCamera();
    mode = 'pick';
    traced = null;
    signatureImage = null;
    wholeFrameRaster = null;
    rectifiedRaster = null;
  }

  function onSensitivityInput(event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (retraceTimer) clearTimeout(retraceTimer);
    // Debounce: retracing a 1000px photo takes tens of ms — fine per
    // adjustment, too slow for every pixel of a slider drag.
    retraceTimer = setTimeout(() => {
      retraceTimer = null;
      const raster = activeTraceRaster();
      if (raster) traced = traceRaster(raster, value / 100);
    }, 120);
  }

  function save() {
    if (!traced || traced.strokes.length === 0) return;
    onSave({
      id: crypto.randomUUID(),
      width: traced.width,
      height: traced.height,
      strokes: traced.strokes,
      ...(signatureImage ? { image: signatureImage } : {})
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
          <div class="relative">
            <!-- svelte-ignore a11y_media_has_caption — live camera preview -->
            <!-- object-contain (not cover) so the quad overlay below can
                 use the same letterboxing and line up with the frame. -->
            <video
              bind:this={videoEl}
              autoplay
              playsinline
              muted
              class="aspect-video w-full rounded-md border border-input bg-black object-contain"
            ></video>
            {#if liveQuad && liveFrame}
              <svg
                aria-hidden="true"
                class="pointer-events-none absolute inset-0 h-full w-full"
                viewBox="0 0 {liveFrame.width} {liveFrame.height}"
                preserveAspectRatio="xMidYMid meet"
              >
                <polygon
                  points={liveQuad.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill="var(--primary)"
                  fill-opacity="0.08"
                  stroke="var(--primary)"
                  stroke-width="2.5"
                  stroke-linejoin="round"
                />
              </svg>
            {/if}
          </div>
          <p class="mt-2 text-xs text-muted-foreground">
            {tUi('pdf.signature.import.holdHint')}
          </p>
        {:else if mode === 'crop'}
          <div class="relative mx-auto w-fit">
            <canvas
              bind:this={cropCanvas}
              class="block max-h-[55vh] max-w-full rounded-md border border-input"
            ></canvas>
            {#if sourceRaster && editedQuad}
              <!-- svelte-ignore a11y_no_static_element_interactions —
                   pointer-driven corner dragging; move/up live on the svg
                   so fast drags don't escape the handle. -->
              <svg
                bind:this={cropSvg}
                class="absolute inset-0 h-full w-full touch-none"
                viewBox="0 0 {sourceRaster.width} {sourceRaster.height}"
                preserveAspectRatio="none"
                onpointermove={onHandleMove}
                onpointerup={onHandleUp}
                onpointercancel={onHandleUp}
              >
                <path
                  d={cropShadePath}
                  fill="black"
                  fill-opacity="0.4"
                  fill-rule="evenodd"
                  pointer-events="none"
                />
                <polygon
                  points={cropQuadPoints}
                  fill="none"
                  stroke="var(--primary)"
                  stroke-width={cropHandleRadius / 3}
                  stroke-linejoin="round"
                  pointer-events="none"
                />
                {#each editedQuad as corner, i (i)}
                  <circle
                    cx={corner.x}
                    cy={corner.y}
                    r={cropHandleRadius}
                    fill="var(--primary)"
                    fill-opacity="0.9"
                    stroke="white"
                    stroke-width={cropHandleRadius / 4}
                    class="cursor-move"
                    onpointerdown={(e) => onHandleDown(e, i)}
                  />
                {/each}
              </svg>
            {/if}
          </div>
          <p class="mt-2 text-xs text-muted-foreground">
            {tUi('pdf.signature.import.cropHint')}
          </p>
        {:else if traced}
          <svg
            role="img"
            aria-label={tUi('pdf.signature.preview')}
            class="aspect-[420/168] w-full rounded-md border border-input bg-white"
            viewBox="0 0 {traced.width} {traced.height}"
            preserveAspectRatio="xMidYMid meet"
          >
            <SignatureStrokes
              strokes={traced.strokes}
              image={signatureImage ?? undefined}
              width={traced.width}
              height={traced.height}
            />
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
              max="100"
              step="1"
              value={Math.round(traced.sensitivity * 100)}
              oninput={onSensitivityInput}
              class="flex-1"
            />
          </label>
          <div class="mt-2 flex items-center justify-between gap-2">
            {#if rectifiedRaster}
              <label class="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={paperCrop}
                  onchange={togglePaperCrop}
                />
                <span class="text-muted-foreground">
                  {tUi('pdf.signature.import.paperCrop')}
                </span>
              </label>
            {:else}
              <div></div>
            {/if}
            {#if sourceRaster}
              <div class="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-7 gap-1 px-2 text-xs"
                  onclick={rotatePhoto}
                >
                  <RotateCw class="size-3.5" aria-hidden="true" />
                  {tUi('pdf.signature.import.rotate')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-7 gap-1 px-2 text-xs"
                  onclick={openCropEditor}
                >
                  <Crop class="size-3.5" aria-hidden="true" />
                  {tUi('pdf.signature.import.adjustCrop')}
                </Button>
              </div>
            {/if}
          </div>
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
        {:else if mode === 'crop'}
          <Button
            variant="ghost"
            size="sm"
            class="h-7 px-2 text-xs"
            onclick={closeCropEditor}
          >
            {tUi('pdf.signature.import.back')}
          </Button>
          <div class="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              class="h-7 px-2 text-xs"
              onclick={resetCropQuad}
            >
              {tUi('pdf.signature.import.cropReset')}
            </Button>
            <Button size="sm" class="h-7 px-2 text-xs" onclick={applyCrop}>
              {tUi('pdf.signature.import.cropApply')}
            </Button>
          </div>
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
